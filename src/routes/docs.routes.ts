import { Router, type IRouter, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { OPENAPI_DOCS_PATH, OPENAPI_JSON_PATH, buildOpenApiSpec } from "../config/openapi/index.js";

const router: IRouter = Router();

router.get(OPENAPI_JSON_PATH, (req: Request, res: Response) => {
  const protocol = req.protocol;
  const host = req.get("host");
  const serverUrl = host ? `${protocol}://${host}` : undefined;
  res.json(buildOpenApiSpec(serverUrl));
});

router.use(
  OPENAPI_DOCS_PATH,
  swaggerUi.serve,
  swaggerUi.setup(undefined, {
    explorer: true,
    customSiteTitle: "Atlas County Scraper API",
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info .title { font-size: 2rem; }
      .swagger-ui .info { margin: 24px 0; }
      .swagger-ui .parameters-col_name .parameter__name:not(.required)::after,
      .swagger-ui table.model tr.property-row:not(.required) .prop-name::after {
        content: "?";
        color: #888;
        font-weight: normal;
        margin-left: 2px;
      }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
      docExpansion: "list",
      defaultModelsExpandDepth: 2,
      url: OPENAPI_JSON_PATH,
    },
  }),
);

export default router;

export { OPENAPI_DOCS_PATH, OPENAPI_JSON_PATH };
