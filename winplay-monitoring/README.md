# Win Play monitoring report

Genera el mensaje de monitoreo para `#customer-care` / tests en Slack a partir de Kibana Insights y Freshdesk.

## Salida

```text
*Nombre del partido*
Señales en Vivo ✅
Login ✅
Logins: N
Tickets: N
Ventas Suscripción en la última hora: N + N PPV
```

`Señales en Vivo` queda fijo en ✅ (no hay consulta que lo calcule).

## Setup

```bash
cd winplay-monitoring
cp .env.example .env   # completar credenciales
npm install
npm run report         # consola con banner
npm run report:slack   # solo el texto del reporte (Cursor / Slack)
```

Variables: `KIBANA_BASE_URL`, `ELASTIC_USER`, `ELASTIC_PASSWORD`, `FRESHDESK_DOMAIN`, `FRESHDESK_API_KEY`. Opcionales: `MATCH_NAME`, `PPV_PRODUCT_ID`, `FRESHDESK_GROUP_ID`.

## Verificación (Nov 2026)

| Fuente | Estado |
|--------|--------|
| Kibana proxy | `POST {KIBANA_BASE_URL}/api/console/proxy?path=logs-prod*/_search&method=POST` — ruta correcta. Sin Basic Auth responde 401. |
| Freshdesk | `GET https://{domain}/api/v2/tickets` — últimos 60 min, excluye tag `sin-correo`. Sin `FRESHDESK_GROUP_ID` no filtra grupo Winplay. |
| Programación | Hoja [Programación destacada WinSports](https://docs.google.com/spreadsheets/d/1wC6SScEOpbc-YkmJfw2eURsJB7eY9BAiL6JCq97exUE/edit?gid=531252591). El script **no** la lee; `MATCH_NAME` / `PPV_PRODUCT_ID` van por env. |

## Cursor en Slack

1. Subir este repo (sin `.env`) y cargar las variables en el environment del Cloud Agent / secrets del equipo.
2. En el hilo: `@Cursor` + pedir que ejecute el reporte y publique **solo** el texto.

Prompt sugerido:

```text
En el repo, cd winplay-monitoring && npm ci && npm run report:slack
Publicá en este hilo únicamente la salida del comando (el bloque del reporte).
No inventes números: si Kibana/Freshdesk fallan, dejá N/D como imprime el script.
MATCH_NAME y PPV_PRODUCT_ID salen de la hoja Programación destacada WinSports (gid 531252591) para el partido en curso; si no hay partido, dejá Sin partido programado.
```

Kibana Insights usa Basic Auth en el borde; el MCP de Kibana/Freshdesk en este entorno puede estar caído. El script HTTP con env vars es el camino estable. Sin credenciales en el environment del agente, Logins/Tickets/Ventas salen `N/D`.
