import type { TemplateParameter } from '../types.js';

const TEMPLATE_PARAM_PATTERN = /\{\{([A-Za-z0-9_-]+)\}\}/g;

function hasParam(params: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) && params[key] !== '';
}

export function applyTemplateParams(
  prompt: string,
  params: Record<string, string>,
  definitions?: TemplateParameter[],
): string {
  if (prompt === '') {
    return '';
  }

  const definitionsByKey = new Map<string, TemplateParameter>();
  for (const definition of definitions ?? []) {
    definitionsByKey.set(definition.key, definition);
    if (!definition.required) {
      continue;
    }

    const hasProvidedValue = hasParam(params, definition.key);
    const hasDefaultValue = definition.default !== undefined && definition.default !== '';
    if (!hasProvidedValue && !hasDefaultValue) {
      throw new Error(`Missing required template parameter: ${definition.key}`);
    }
  }

  return prompt.replace(TEMPLATE_PARAM_PATTERN, (match, key: string) => {
    if (hasParam(params, key)) {
      return params[key];
    }

    const definition = definitionsByKey.get(key);
    if (definition?.default !== undefined) {
      return definition.default;
    }

    return definition ? '' : match;
  });
}
