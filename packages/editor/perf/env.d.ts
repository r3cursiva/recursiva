// The perf harness imports fixtures as text (esbuild's text loader) and the content styles (bundled as CSS).
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*.css";
