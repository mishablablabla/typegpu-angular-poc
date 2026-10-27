import type { ExampleDefinition, Variant } from './example.model';

/** What the source viewer shows: the implementation and, if the URL names one that this implementation has, the file. */
export interface ViewState {
  variant: Variant;
  file: string | undefined;
}

/** The two query parameters of an example page, in the form `Router.navigate({ queryParams })` takes (`null` removes one). */
export interface ViewQuery {
  variant: 'manual' | null;
  file: string | null;
}

interface Params {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/** The file if this implementation has it (the shader is in both, the component and the GPU root are not), otherwise `undefined`. */
export const fileIn = (example: ExampleDefinition, variant: Variant, file: string | null | undefined): string | undefined =>
  file != null && example.sources[variant].some((source) => source.path === file) ? file : undefined;

/** The default implementation has no parameter: a URL without `?variant=` is the integrated version. */
export function resolveViewState(example: ExampleDefinition, params: Params): ViewState {
  const variant: Variant = params.get('variant') === 'manual' ? 'manual' : 'integration';
  // A file only counts for the implementation that has it: `?variant=manual&file=manual-gpu.ts` is not valid for the integrated version.
  return { variant, file: fileIn(example, variant, params.get('file')) };
}

export const viewQuery = (state: ViewState): ViewQuery => ({ variant: state.variant === 'manual' ? 'manual' : null, file: state.file ?? null });

/** Does the URL already say exactly what `viewQuery(state)` says (no invalid, stale or repeated values)? */
export const isCanonical = (params: Params, query: ViewQuery): boolean =>
  sameValues(params.getAll('variant'), query.variant) && sameValues(params.getAll('file'), query.file);

const sameValues = (actual: string[], wanted: string | null): boolean => (wanted === null ? actual.length === 0 : actual.length === 1 && actual[0] === wanted);
