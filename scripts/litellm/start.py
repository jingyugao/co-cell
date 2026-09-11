"""Start LiteLLM with the host-owned, access-token-only login contract."""
import time

from litellm.llms.chatgpt.authenticator import Authenticator
from litellm.llms.chatgpt.common_utils import GetAccessTokenError
from litellm.proxy.proxy_cli import run_server


def host_access_token(self):
    auth = self._read_auth_file()
    if auth:
        token = auth.get("access_token")
        expiry = auth.get("expires_at")
        if isinstance(token, str) and token and isinstance(expiry, (int, float)) and expiry > time.time() + 60:
            return token
    # This proxy never refreshes the host login or starts an unattended device
    # login. The host sync service is the only credential writer.
    raise GetAccessTokenError(message="Host Codex login unavailable or expired; renew the host login and check the token sync service.", status_code=401)


Authenticator.get_access_token = host_access_token

if __name__ == "__main__":
    run_server()
