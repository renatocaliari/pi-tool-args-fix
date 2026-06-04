/**
 * Type declarations for @earendil-works/pi-coding-agent.
 * This package is provided by the pi runtime and is not installed via npm.
 */

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
    registerCommand(name: string, def: { description: string; handler: (args: any, ctx: any) => Promise<void> }): void;
    registerTool(name: string, def: any): void;
    registerShortcut(def: any): void;
  }
}
