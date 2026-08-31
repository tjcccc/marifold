interface ProviderErrorLike {
  code?: string;
  message?: string;
}

/** Whether a provider rejected the hosted-search capability itself. Retrying
 * through Marifold search is safe only before any provider output is exposed. */
export function isNativeWebSearchCapabilityError(error: ProviderErrorLike | undefined): boolean {
  if (error?.code !== 'PROVIDER_ERROR' || !error.message) {
    return false;
  }
  const message = error.message.toLowerCase();
  const mentionsNativeSearch = /web[\s_-]*search|enable_search|hosted search|server[\s_-]*side tool|provider tool|responses api|\/responses\b|\btools?\b/.test(message);
  const rejectsCapability = /not supported|unsupported|does not support|unavailable|not available|unknown|unrecognized|invalid|incompatible|cannot use|can't use/.test(message);
  const responsesEndpointMissing = /openai-responses|\/responses\b/.test(message)
    && /http (?:404|405)|not found|method not allowed/.test(message);
  return (mentionsNativeSearch && rejectsCapability) || responsesEndpointMissing;
}
