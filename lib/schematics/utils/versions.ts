import { SchematicsException } from '@angular-devkit/schematics';
import { CUSTOM_ESBUILD, REFUSAL_NOTE, SUPPORTED_ANGULAR_MAJORS } from './constants';

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** The lowest version a dependency range can resolve to (`^0.12.8` -> 0.12.8). Undefined for `latest`, tags, URLs. */
export function lowestVersion(range: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return match ? { major: +match[1]!, minor: +match[2]!, patch: +match[3]! } : undefined;
}

export function angularMajor(range: string | undefined): number {
  const version = range ? lowestVersion(range) : undefined;
  if (!version) {
    throw new SchematicsException(
      `Cannot tell the Angular version from "@angular/core": "${range ?? '(missing)'}" in package.json. ` +
        `Use a version range such as ^22.0.0 and run the schematic again.\n${REFUSAL_NOTE}`,
    );
  }
  if (!SUPPORTED_ANGULAR_MAJORS.includes(version.major)) {
    throw new SchematicsException(
      `Angular ${version.major} is not supported. This package was built and tested with Angular ${SUPPORTED_ANGULAR_MAJORS.join(', ')}.\n${REFUSAL_NOTE}`,
    );
  }
  return version.major;
}

/** `typegpu` must be in `^0.12.8` (the package's peer range). */
export function assertTypegpuRange(range: string): Version {
  const version = lowestVersion(range);
  if (!version || version.major !== 0 || version.minor !== 12 || version.patch < 8) {
    throw new SchematicsException(
      `package.json has typegpu "${range}", but this package needs typegpu ^0.12.8. Update it and run the schematic again.\n${REFUSAL_NOTE}`,
    );
  }
  return version;
}

/** The unplugin-typegpu release whose `typegpu` peer range matches (both pairs were built and tested). */
export function unpluginVersionFor(typegpu: Version): string {
  return typegpu.patch >= 9 ? '0.12.7' : '0.12.6';
}

/**
 * Dependencies the project already has that this package was not tested with. `ng add` keeps them (it never changes an existing entry), but
 * says so: the failure otherwise shows later, in an install or a build, far from `ng add`.
 */
export function dependencyWarnings(rangeOf: (name: string) => string | undefined, angular: number, typegpu: Version, pluginMode: boolean): string[] {
  const warnings: string[] = [];
  const lowest = (name: string) => {
    const range = rangeOf(name);
    return range === undefined ? undefined : { range, version: lowestVersion(range) };
  };
  const ts = lowest('typescript');
  if (ts?.version && (ts.version.major < 5 || (ts.version.major === 5 && ts.version.minor < 5))) {
    warnings.push(`typescript "${ts.range}" is older than 5.5, the lowest version this package supports (peer range >=5.5.0).`);
  }
  const unplugin = lowest('unplugin-typegpu');
  if (unplugin?.version) {
    const { major, minor, patch } = unplugin.version;
    if (major !== 0 || minor !== 12 || patch < 6) {
      warnings.push(`unplugin-typegpu "${unplugin.range}" is outside ^0.12.6, the range this package was tested with.`);
    } else if (patch >= 7 && /^\d/.test(rangeOf('typegpu') ?? '') && typegpu.patch < 9) {
      warnings.push(`unplugin-typegpu "${unplugin.range}" needs typegpu ^0.12.9, but package.json pins typegpu ${rangeOf('typegpu')}: npm reports a peer conflict.`);
    }
  }
  const esbuild = lowest('esbuild');
  if (esbuild?.version && esbuild.version.major === 0 && esbuild.version.minor < 24) {
    warnings.push(`esbuild "${esbuild.range}" is older than 0.24 (peer range >=0.24.0).`);
  }
  if (pluginMode) {
    const custom = lowest(CUSTOM_ESBUILD);
    if (custom?.version && custom.version.major !== angular) {
      warnings.push(`${CUSTOM_ESBUILD} "${custom.range}" is for Angular ${custom.version.major}, but the project uses Angular ${angular}: use ^${angular}.0.0.`);
    }
  }
  return warnings;
}
