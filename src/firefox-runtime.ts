import { ContextOwnerError, createContextOwnerRuntime } from "./context-owner.ts";
export type {
  ContextOwner as FirefoxOwner, ContextReservation as FirefoxReservation,
  StartContextOwnerInput as StartFirefoxOwnerInput, ContextOwnerCallbacks as FirefoxOwnerCallbacks,
  ContextOwnerErrorDetails as FirefoxOwnerErrorDetails, JsonValue,
} from "./context-owner.ts";
export class FirefoxOwnerError extends ContextOwnerError {
  constructor(...args: ConstructorParameters<typeof ContextOwnerError>) { super(...args); this.name = "FirefoxOwnerError"; }
}
const runtime = createContextOwnerRuntime("firefox", FirefoxOwnerError);
export const reserveFirefoxOwner = runtime.reserve;
export const firefoxOwnerReady = runtime.ready;
export const startFirefoxOwner = runtime.start;
export const firefoxEndpoint = runtime.endpoint;
export const firefoxOwnerForEndpoint = runtime.ownerForEndpoint;
export const forgetFirefoxOwner = runtime.forget;
export const callFirefoxOwner = runtime.call;
export const closeFirefoxOwner = runtime.close;
