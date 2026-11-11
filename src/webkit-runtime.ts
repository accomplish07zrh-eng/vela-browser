import { ContextOwnerError, createContextOwnerRuntime } from "./context-owner.ts";
export type {
  ContextOwner as WebKitOwner, ContextReservation as WebKitReservation,
  StartContextOwnerInput as StartWebKitOwnerInput, ContextOwnerCallbacks as WebKitOwnerCallbacks,
  ContextOwnerErrorDetails as WebKitOwnerErrorDetails, JsonValue,
} from "./context-owner.ts";
export class WebKitOwnerError extends ContextOwnerError {
  constructor(...args: ConstructorParameters<typeof ContextOwnerError>) { super(...args); this.name = "WebKitOwnerError"; }
}
const runtime = createContextOwnerRuntime("webkit", WebKitOwnerError);
export const reserveWebKitOwner = runtime.reserve;
export const webkitOwnerReady = runtime.ready;
export const startWebKitOwner = runtime.start;
export const webkitEndpoint = runtime.endpoint;
export const webkitOwnerForEndpoint = runtime.ownerForEndpoint;
export const forgetWebKitOwner = runtime.forget;
export const callWebKitOwner = runtime.call;
export const closeWebKitOwner = runtime.close;
