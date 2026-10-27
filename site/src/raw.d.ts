// `import source from './file.ts?source'`: the file's text (see tools/source-text.esbuild.mjs).
declare module '*?source' {
  const text: string;
  export default text;
}
