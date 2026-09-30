/** An error the SDK manager returns to a plugin call; the key goes to the plugin and the log. */
export class SdkError extends Error {
  constructor(
    readonly key: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(key);
    this.name = 'SdkError';
  }
}
