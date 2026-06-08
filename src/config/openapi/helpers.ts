type OpenApiParam = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
};

type SchemaProp = Record<string, unknown>;

function withOptionalMarker(label: string, description?: string): string {
  const base = description ?? label;
  return base.endsWith("?") ? base : `${base}?`;
}

function withRequiredMarker(label: string, description?: string): string {
  const base = description ?? label;
  return base.replace(/\?$/, "");
}

/** Optional query/path parameter — `required: false`, description suffixed with `?`. */
export function optParam(param: OpenApiParam): OpenApiParam {
  return {
    ...param,
    required: false,
    description: withOptionalMarker(param.name, param.description),
  };
}

/** Required parameter — no `?` in description. */
export function reqParam(param: OpenApiParam): OpenApiParam {
  return {
    ...param,
    required: true,
    description: withRequiredMarker(param.name, param.description),
  };
}

/** Optional schema property — description suffixed with `?`. */
export function optProp(key: string, schema: SchemaProp): [string, SchemaProp] {
  return [
    key,
    {
      ...schema,
      description: withOptionalMarker(key, schema.description as string | undefined),
    },
  ];
}

/** Build properties object; listed keys are optional (description gets `?`). */
export function optProps(
  entries: Record<string, SchemaProp>,
): Record<string, SchemaProp> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, schema]) => optProp(key, schema)),
  );
}

/** Required schema property — no `?`. */
export function reqProp(key: string, schema: SchemaProp): [string, SchemaProp] {
  return [
    key,
    {
      ...schema,
      description: withRequiredMarker(key, schema.description as string | undefined),
    },
  ];
}

export function optBody(content: Record<string, unknown>): {
  required: false;
  content: Record<string, unknown>;
} {
  return { required: false, content };
}

export function reqBody(content: Record<string, unknown>): {
  required: true;
  content: Record<string, unknown>;
} {
  return { required: true, content };
}
