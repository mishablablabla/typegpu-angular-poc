// Is one path inside another folder? Decided by `relative`, not by a string prefix: a prefix test is case-sensitive (Windows paths are
// not), it matches a sibling that merely starts with the same letters (`shaders-dist-old` for `shaders-dist`), and it breaks on a root
// (`C:\` + `\`). `pathApi` is injectable so the Windows rules can be tested on any platform (`path.win32`).
import path from 'node:path';

/** Whether `child` is `parent` or a path below it (the paths are resolved first; nothing on disk is looked at). */
export function isSameOrInside(parent, child, pathApi = path) {
  const rel = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  if (rel === '') return true;
  // `..` and `..\x` leave the folder; a name that merely starts with dots (`..hidden`) does not. An absolute result is another drive or share.
  return rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
}

/** Whether `child` lies strictly below `parent` (a folder is not inside itself). */
export function isInside(parent, child, pathApi = path) {
  return isSameOrInside(parent, child, pathApi) && pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child)) !== '';
}
