import { ArrowUp, ArrowDown } from "react-feather";
import { useState } from "react";

function Event({ event, timestamp }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isClient = event.event_id && !event.event_id.startsWith("event_");
  const isTranscription = event.isTranscription;

  // Special rendering for transcription events
  if (isTranscription) {
    const isLive = event.type === "input_audio_buffer.transcription.live";
    return (
      <div className="flex flex-col gap-2 p-3 rounded-md bg-blue-50 border-2 border-blue-200">
        <div className="flex items-center gap-2">
          <div className="text-sm font-semibold text-blue-700">
            🎤 Microphone Input {isLive ? "(live)" : "(completed)"}
          </div>
          <div className="text-xs text-gray-500 ml-auto">{timestamp}</div>
        </div>
        <div className="text-base text-gray-800 bg-white p-3 rounded-md border border-blue-200">
          {event.text || "..."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2 rounded-md bg-gray-50">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isClient ? (
          <ArrowDown className="text-blue-400" />
        ) : (
          <ArrowUp className="text-green-400" />
        )}
        <div className="text-sm text-gray-500">
          {isClient ? "client:" : "server:"}
          &nbsp;{event.type} | {timestamp}
        </div>
      </div>
      <div
        className={`text-gray-500 bg-gray-200 p-2 rounded-md overflow-x-auto ${
          isExpanded ? "block" : "hidden"
        }`}
      >
        <pre className="text-xs">{JSON.stringify(event, null, 2)}</pre>
      </div>
    </div>
  );
}

export default function EventLog({ events }) {
  const eventsToDisplay = [];
  let deltaEvents = {};

  events.forEach((event) => {
    // Skip delta events that aren't transcription (they're handled specially)
    if (event.type.endsWith("delta") && !event.isTranscription) {
      if (deltaEvents[event.type]) {
        // for now just log a single event per render pass
        return;
      } else {
        deltaEvents[event.type] = event;
      }
    }

    // Use a unique key that includes the event_id and type
    const key = event.isTranscription 
      ? `transcription-${event.event_id}-${event.type}`
      : event.event_id || `${event.type}-${Math.random()}`;

    eventsToDisplay.push(
      <Event key={key} event={event} timestamp={event.timestamp} />,
    );
  });

  return (
    <div className="flex flex-col gap-2 overflow-x-auto">
      {events.length === 0 ? (
        <div className="text-gray-500">Awaiting events...</div>
      ) : (
        eventsToDisplay
      )}
    </div>
  );
}
