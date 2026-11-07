const slackOnly = process.argv.includes('--slack');
require('dotenv').config({ quiet: slackOnly });
const axios = require('axios');

const basicAuth = (user, pass) => Buffer.from(`${user}:${pass}`).toString('base64');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function kibanaHeaders() {
  return {
    Authorization: `Basic ${basicAuth(requireEnv('ELASTIC_USER'), requireEnv('ELASTIC_PASSWORD'))}`,
    'Content-Type': 'application/json',
    'kbn-xsrf': 'true'
  };
}

async function queryKibana(indexPattern, payload) {
  const baseUrl = requireEnv('KIBANA_BASE_URL').replace(/\/$/, '');
  const url = `${baseUrl}/api/console/proxy?path=${encodeURIComponent(`${indexPattern}/_search`)}&method=POST`;

  try {
    const res = await axios.post(url, payload, {
      headers: kibanaHeaders(),
      timeout: 30000
    });

    if (res.data?.error) {
      const reason = res.data.error.reason || res.data.error.type || 'error de Elasticsearch';
      throw new Error(reason);
    }

    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    throw new Error(status ? `Kibana ${status}: ${message}` : message);
  }
}

function hitCount(data) {
  const total = data?.hits?.total;
  if (typeof total === 'number') return total;
  return total?.value ?? 0;
}

// 1. Logins (últimos 30 min)
async function getUniqueLogins() {
  const gteDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const payload = {
    size: 0,
    query: {
      bool: {
        filter: [
          { multi_match: { query: 'winsports', type: 'best_fields', lenient: true } },
          { range: { date_iso: { gte: gteDate } } },
          {
            bool: {
              should: [
                { term: { 'origin.keyword': 'CLOUDPASS' } },
                { match_phrase: { origin: 'DTVMAVERICK' } }
              ],
              minimum_should_match: 1
            }
          },
          {
            bool: {
              should: [
                { match_phrase: { action: 'login' } },
                { match_phrase: { action: 'tvlogin' } },
                { match_phrase: { action: 'msologin' } }
              ],
              minimum_should_match: 1
            }
          }
        ]
      }
    },
    aggs: {
      unique_subscribers: {
        cardinality: { field: 'user.subscriberId.keyword' }
      }
    }
  };

  try {
    const data = await queryKibana('logs-prod*', payload);
    return data?.aggregations?.unique_subscribers?.value ?? 0;
  } catch (err) {
    console.error('Error Kibana Logins:', err.message);
    return 'N/D';
  }
}

// 2. Suscripciones DTC y PPV (última 1 hora)
async function getSalesMetrics(ppvProductId = process.env.PPV_PRODUCT_ID || null) {
  const gteDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const subsPayload = {
    track_total_hits: true,
    size: 0,
    query: {
      bool: {
        filter: [
          { range: { date_iso: { gte: gteDate } } },
          { match_phrase: { 'user.identityProvider.shortName': 'winsports' } },
          { term: { 'origin.keyword': 'CLOUDPAY' } },
          { match_phrase: { 'paymentData.transactionType': 'SUBSCRIPTION' } },
          { match_phrase: { 'paymentData.status': 'SUCCESSFUL' } },
          { match_phrase: { 'paymentData.sellingModel': 'DTC' } }
        ],
        must_not: [
          { term: { 'paymentData.paymentProcessor.keyword': 'access' } },
          { term: { 'paymentData.paymentProcessor.keyword': 'freepass' } }
        ]
      }
    }
  };

  const ppvFilters = [
    { multi_match: { query: 'ppv', type: 'best_fields', lenient: true } },
    { range: { date_iso: { gte: gteDate } } },
    { match_phrase: { 'user.identityProvider.shortName': 'winsports' } },
    { match_phrase: { status: 'SUCCESSFUL' } }
  ];

  if (ppvProductId) {
    ppvFilters.push({
      match_phrase: { 'billingData.purchasedProducts.productId': ppvProductId }
    });
  }

  const ppvPayload = {
    track_total_hits: true,
    size: 0,
    query: { bool: { filter: ppvFilters } }
  };

  let subsCount = 0;
  let ppvCount = 0;

  try {
    const resSubs = await queryKibana('logs-prod*', subsPayload);
    subsCount = hitCount(resSubs);
  } catch (err) {
    console.error('Error Kibana Suscripciones:', err.message);
    subsCount = 'N/D';
  }

  try {
    const resPpv = await queryKibana('logs-prod*', ppvPayload);
    ppvCount = hitCount(resPpv);
  } catch (err) {
    console.error('Error Kibana PPV:', err.message);
    ppvCount = 'N/D';
  }

  return { subsCount, ppvCount };
}

// 3. Tickets Freshdesk (últimos 60 min, sin "sin-correo")
// Opcional: FRESHDESK_GROUP_ID limita al grupo Winplay (Admin > Groups en Freshdesk).
async function getFreshdeskTickets() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const domain = requireEnv('FRESHDESK_DOMAIN');
  const groupId = process.env.FRESHDESK_GROUP_ID
    ? String(process.env.FRESHDESK_GROUP_ID).trim()
    : null;
  const headers = {
    Authorization: `Basic ${basicAuth(requireEnv('FRESHDESK_API_KEY'), 'X')}`,
    'Content-Type': 'application/json'
  };

  try {
    let count = 0;

    for (let page = 1; page <= 10; page += 1) {
      const res = await axios.get(`https://${domain}/api/v2/tickets`, {
        headers,
        timeout: 20000,
        params: {
          order_by: 'created_at',
          order_type: 'desc',
          per_page: 100,
          page
        }
      });

      const tickets = res.data || [];
      if (tickets.length === 0) break;

      let reachedOlder = false;
      for (const ticket of tickets) {
        const createdAt = new Date(ticket.created_at);
        if (createdAt < oneHourAgo) {
          reachedOlder = true;
          continue;
        }
        if (groupId && String(ticket.group_id) !== groupId) continue;
        const hasExcludedTag = Array.isArray(ticket.tags) && ticket.tags.includes('sin-correo');
        if (!hasExcludedTag) count += 1;
      }

      if (reachedOlder || tickets.length < 100) break;
    }

    return count;
  } catch (err) {
    const status = err.response?.status;
    console.error('Error Freshdesk:', status ? `${status} ${err.message}` : err.message);
    return 'N/D';
  }
}

function formatReport(logins, freshdeskTickets, sales) {
  const matchName = process.env.MATCH_NAME || 'Sin partido programado';
  const loginStatus = logins === 'N/D' ? '⚠️' : '✅';

  return `*${matchName}*
Señales en Vivo ✅
Login ${loginStatus}
Logins: ${logins}
Tickets: ${freshdeskTickets}
Ventas Suscripción en la última hora: ${sales.subsCount} + ${sales.ppvCount} PPV`;
}

async function runReport() {
  if (!slackOnly) {
    console.log('Consultando métricas en tiempo real...');
  }

  const [logins, freshdeskTickets, sales] = await Promise.all([
    getUniqueLogins(),
    getFreshdeskTickets(),
    getSalesMetrics()
  ]);

  const messageText = formatReport(logins, freshdeskTickets, sales);

  if (slackOnly) {
    console.log(messageText);
    return;
  }

  console.log('\n========================================');
  console.log('     REPORTE GENERADO PARA SLACK        ');
  console.log('========================================\n');
  console.log(messageText);
  console.log('\n========================================\n');
}

runReport();
