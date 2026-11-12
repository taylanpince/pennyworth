export class SlackAuth {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.url}/auth/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      throw new Error("Slack connection unavailable; try reconnecting");
    return res.json();
  }
}
