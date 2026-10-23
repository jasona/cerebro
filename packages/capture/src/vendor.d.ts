/** `@tesseract.js-data/eng` ships no types: it exports the path of its bundled English traineddata. */
declare module "@tesseract.js-data/eng" {
  const data: { code: string; gzip: boolean; langPath: string };
  export default data;
}
