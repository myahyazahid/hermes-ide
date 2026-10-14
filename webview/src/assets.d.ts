// esbuild inlines images as data: URLs (see esbuild.mjs).
declare module "*.png" {
  const url: string;
  export default url;
}
