declare module "read-cmd-shim" {
  interface ReadCmdShim {
    (path: string): Promise<string>;
    sync(path: string): string;
  }
  const readCmdShim: ReadCmdShim;
  export default readCmdShim;
}
