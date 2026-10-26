import { SchematicsException } from '@angular-devkit/schematics';
import { REFUSAL_NOTE, SUPPORTED_ANGULAR_MAJORS } from './constants';

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
