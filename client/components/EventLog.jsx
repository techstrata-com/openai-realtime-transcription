export default function EventLog({ events }) {
  // Filter to only input transcription events (STT - Persian/Farsi text from English voice)
  const transcriptionEvents = events.filter(
    (event) => 
      (event.isTranscription && event.isInput) ||
      event.type?.includes("input_audio_transcription") ||
      event.type?.includes("input_audio_buffer.transcription")
  );

  // Get the most recent live transcription or the latest completed one
  const liveTranscription = transcriptionEvents.find(
    (e) => e.type === "input_audio_buffer.transcription.live" || e.type?.includes("transcription.live")
  );

  const latestTranscription = liveTranscription || 
    transcriptionEvents.find((e) => e.text || e.transcript) ||
    transcriptionEvents[0];

  const transcriptionText = latestTranscription?.text || latestTranscription?.transcript || "";

  return (
    <div className="flex flex-col gap-2 overflow-x-auto h-full">
      {transcriptionText ? (
        <div className="flex flex-col gap-2 p-4">
          <div className="text-sm font-semibold text-blue-700 mb-2">
            🎤 Transcribed Text (Persian/Farsi)
          </div>
          <div className="text-lg text-gray-800 bg-white p-4 rounded-md border-2 border-blue-200 min-h-[100px] whitespace-pre-wrap">
            {transcriptionText}
            {liveTranscription && (
              <span className="animate-pulse">|</span>
            )}
          </div>
        </div>
      ) : (
        <div className="text-gray-500 p-4">Awaiting transcription... Speak into the microphone.</div>
      )}
    </div>
  );
}
