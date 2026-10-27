/** The documentation sidebar. Same topics and order as the TypeGPU docs; only our own page is implemented here. */

const OFFICIAL = 'https://docs.swmansion.com/TypeGPU';

export interface NavItem {
  label: string;
  /** In-app route (only pages implemented in this site). */
  route?: string;
  /** Official TypeGPU documentation page: opens docs.swmansion.com, nothing is reproduced here. */
  external?: string;
  badge?: 'new' | 'experimental';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export const isGroup = (entry: NavEntry): entry is NavGroup => 'items' in entry;

const official = (label: string, path: string, badge?: NavItem['badge']): NavItem => ({
  label,
  external: `${OFFICIAL}${path}`,
  badge,
});

export const ANGULAR_DOCS_ROUTE = '/docs/ecosystem/typegpu-angular';

export const DOCS_NAV: NavEntry[] = [
  official('Why TypeGPU?', '/why-typegpu/'),
  official('Getting Started', '/getting-started/'),
  {
    label: 'Fundamentals',
    items: [
      official('Your first GPU program', '/fundamentals/your-first-gpu-program/', 'new'),
      official('Going parallel with reusable resources', '/fundamentals/compute-shaders/', 'new'),
      official('Vertices and fragments', '/fundamentals/vertices-and-fragments/', 'new'),
    ],
  },
  {
    label: 'APIs',
    items: [
      official('Roots', '/apis/roots/'),
      official('Functions', '/apis/functions/'),
      official('Pipelines', '/apis/pipelines/', 'new'),
      official('Buffers', '/apis/buffers/'),
      official('Textures', '/apis/textures/', 'new'),
      official('Variables', '/apis/variables/'),
      official('Data Schemas', '/apis/data-schemas/'),
      official('Bind Groups', '/apis/bind-groups/'),
      official('Resolve', '/apis/resolve/'),
      official('Vertex Layouts', '/apis/vertex-layouts/'),
      official('Slots', '/apis/slots/'),
      official('Accessors', '/apis/accessors/'),
      official('Utilities', '/apis/utils/', 'new'),
    ],
  },
  {
    label: 'Advanced',
    items: [
      official('Enabling Features', '/advanced/enabling-features/'),
      official('Timing Your Pipelines', '/advanced/timestamp-queries/'),
      official('Minifying & Obfuscating Shaders', '/advanced/minifying-shaders/', 'new'),
    ],
  },
  {
    label: 'Integration',
    items: [
      official('WebGPU Interoperability', '/integration/webgpu-interoperability/'),
      official('React Native', '/integration/react-native/'),
      official('React Native Worklets', '/integration/react-native/worklets/', 'experimental'),
      official('WESL Interoperability', '/integration/wesl-interoperability/'),
      official('Working with wgpu-matrix', '/integration/working-with-wgpu-matrix/'),
    ],
  },
  {
    label: 'Ecosystem',
    items: [
      official('@typegpu/noise', '/ecosystem/typegpu-noise/'),
      official('@typegpu/three', '/ecosystem/typegpu-three/'),
      official('@typegpu/react', '/ecosystem/typegpu-react/'),
      { label: '@typegpu/angular', route: ANGULAR_DOCS_ROUTE, badge: 'experimental' },
      official('@typegpu/gl', '/ecosystem/typegpu-gl/', 'experimental'),
      official('@typegpu/sdf', '/ecosystem/typegpu-sdf/'),
      official('@typegpu/radiance-cascades', '/ecosystem/typegpu-radiance-cascades/'),
    ],
  },
  {
    label: 'Tooling',
    items: [
      official('TypeGPU CLI', '/tooling/typegpu-cli/', 'new'),
      official('Build Plugin', '/tooling/unplugin-typegpu/'),
      official('Lint Plugin', '/tooling/eslint-plugin-typegpu/', 'new'),
      official('AI Tools', '/tooling/ai-tools/', 'new'),
      official('WGSL to TypeGPU', '/tooling/tgpu-gen/'),
    ],
  },
  {
    label: 'Migrations',
    items: [official('Migrating to 0.12', '/migrations/0-12/'), official('Migrating to 0.11', '/migrations/0-11/')],
  },
];
