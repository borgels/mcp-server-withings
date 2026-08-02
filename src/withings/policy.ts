export function writesEnabled(): boolean {
  return process.env.WITHINGS_ENABLE_WRITES === 'true';
}

export function trustForwardedUser(): boolean {
  return process.env.WITHINGS_TRUST_FORWARDED_USER === 'true';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Withings MCP instance (${action}). Set WITHINGS_ENABLE_WRITES=true.`,
    );
  }
}

/**
 * Per-user isolation: every data/enrollment tool needs the gateway-verified
 * identity. Without it the server refuses — nobody gets anonymous or shared
 * access to anyone's health data.
 */
export function requireUser(onBehalfOf: string | undefined): string {
  if (!onBehalfOf) {
    throw new Error(
      'No verified user identity. This connector only works behind a gateway that forwards the signed-in user (X-MCP-User); each user sees only their own Withings data.',
    );
  }
  return onBehalfOf;
}
