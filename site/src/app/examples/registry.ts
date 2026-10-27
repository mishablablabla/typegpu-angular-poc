import type { ExampleDefinition } from './example.model';
import { LIFE } from './life/life.example';
import { CORE } from './core/core.example';
import { RISK_FIELD } from './risk-field/risk-field.example';
import { AUTOSCALER } from './autoscaler/autoscaler.example';
import { NEURAL_FLOW } from './neural-flow/neural-flow.example';
import { MATRIX } from './matrix/matrix.example';

export const EXAMPLES: readonly ExampleDefinition[] = [MATRIX, NEURAL_FLOW, AUTOSCALER, CORE, LIFE, RISK_FIELD];

export const findExample = (id: string | null | undefined): ExampleDefinition | undefined => EXAMPLES.find((example) => example.id === id);
