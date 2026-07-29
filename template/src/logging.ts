export interface SafeLogEvent {
  eventHash: string;
  stage: string;
  durationMs: number;
  httpStatus: number | null;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  chunkCount: number | null;
  personaHash: string | null;
}

export function safeLog(event: SafeLogEvent): void {
  const record: SafeLogEvent = {
    eventHash: event.eventHash,
    stage: event.stage,
    durationMs: event.durationMs,
    httpStatus: event.httpStatus,
    errorCode: event.errorCode,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    chunkCount: event.chunkCount,
    personaHash: event.personaHash,
  };

  console.log(JSON.stringify(record));
}
