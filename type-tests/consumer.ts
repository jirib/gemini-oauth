import {
  GeminiAuthStore,
  GeminiUpstream,
  startAgyOAuthServer,
  type AuthStoreOptions,
  type ServerOptions,
} from "agy-oauth";

const authOptions: AuthStoreOptions = {
  useAntigravityKeyring: false,
  fetch,
};
const auth = new GeminiAuthStore(authOptions);
const upstream = new GeminiUpstream({ auth, fetch });
const serverOptions: ServerOptions = {
  auth,
  port: 0,
  fetch,
  maxBodyBytes: 1024,
};

void upstream;
void startAgyOAuthServer(serverOptions);
