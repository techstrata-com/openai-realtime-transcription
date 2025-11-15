import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const transcriptionText = useRef({}); // Track transcription by item_id
  const currentItemId = useRef(null);
  const sessionConfigured = useRef(false);

  async function startSession() {
    // Get a session token for OpenAI Realtime API
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.value;

    // Create a peer connection
    const pc = new RTCPeerConnection();

    // Add local audio track for microphone input in the browser (STT only - no audio output)
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    pc.addTrack(ms.getTracks()[0]);

    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const model = "gpt-4o-transcribe"; // Use transcription model
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const sdp = await sdpResponse.text();
    const answer = { type: "answer", sdp };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
  }

  // Send a message to the model
  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      // send event before setting timestamp since the backend peer doesn't expect this field
      dataChannel.send(JSON.stringify(message));

      // if guard just in case the timestamp exists by miracle
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Removed sendTextMessage - transcription only, no conversation

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        console.log("Event:", event);

        // Filter events - only process transcription-related events
        const isTranscriptionEvent = 
          event.type === "conversation.item.input_audio_transcription.delta" ||
          event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "input_audio_buffer.committed";
        
        const isNonTranscriptionEvent = 
          event.type?.includes("response") ||
          event.type?.includes("session.created") ||
          event.type?.includes("session.updated") ||
          (event.type?.includes("conversation.item") && !event.type?.includes("input_audio_transcription"));
        
        // Only log transcription-related events
        if (isTranscriptionEvent) {
          console.log("Transcription event:", event.type, event);
        }
        
        // Skip non-transcription events
        if (isNonTranscriptionEvent || !isTranscriptionEvent) {
          return; // Skip non-transcription events
        }

        // Handle input_audio_buffer.committed - new speech turn started
        if (event.type === "input_audio_buffer.committed") {
          currentItemId.current = event.item_id;
          transcriptionText.current[event.item_id] = "";
          
          // Clear previous transcriptions when new speech starts
          setEvents((prev) => prev.filter((e) => !e.isTranscription || e.item_id !== event.item_id));
          return; // Don't add committed event to log
        }
        
        // Handle conversation.item.input_audio_transcription.delta events (live streaming transcription)
        // For gpt-4o-transcribe, delta contains incremental transcripts
        if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
          const itemId = event.item_id;
          
          // Initialize transcription text for this item if needed
          if (!transcriptionText.current[itemId]) {
            transcriptionText.current[itemId] = "";
          }
          
          // Append delta (for gpt-4o-transcribe, deltas are incremental)
          transcriptionText.current[itemId] += event.delta;
          
          const transcriptionEvent = {
            type: "input_audio_transcription.live",
            event_id: event.event_id,
            item_id: itemId,
            text: transcriptionText.current[itemId],
            timestamp: event.timestamp || new Date().toLocaleTimeString(),
            isTranscription: true,
          };
          
          setEvents((prev) => {
            const filtered = prev.filter(
              (e) => !(e.isTranscription && e.item_id === itemId)
            );
            return [transcriptionEvent, ...filtered];
          });
          return; // Don't add the raw delta event to the log
        }
        
        // Handle conversation.item.input_audio_transcription.completed events
        if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
          const itemId = event.item_id;
          
          const transcriptionEvent = {
            type: "input_audio_transcription.completed",
            event_id: event.event_id,
            item_id: itemId,
            text: event.transcript,
            timestamp: event.timestamp || new Date().toLocaleTimeString(),
            isTranscription: true,
          };
          
          setEvents((prev) => {
            const filtered = prev.filter(
              (e) => !(e.isTranscription && e.item_id === itemId)
            );
            return [transcriptionEvent, ...filtered];
          });
          
          // Clean up transcription text for this item
          delete transcriptionText.current[itemId];
          if (currentItemId.current === itemId) {
            currentItemId.current = null;
          }
          return; // Don't add the original event again
        }
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        transcriptionText.current = {};
        currentItemId.current = null;
        sessionConfigured.current = false;
        
        // Configure transcription session
        sendClientEvent({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000
                },
                noise_reduction: {
                  type: "near_field"
                },
                transcription: {
                  model: "gpt-4o-transcribe",
                  language: "en",
                  prompt: "Transcribe the English speech and translate it to Persian (Farsi). Only provide the Persian translation."
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500
                }
              }
            }
          },
        });
        sessionConfigured.current = true;
      });
    }
  }, [dataChannel]);

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>realtime console</h1>
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0">
        <section className="absolute top-0 left-0 right-[380px] bottom-0 flex">
          <section className="absolute top-0 left-0 right-0 bottom-32 px-4 overflow-y-auto">
            <EventLog events={events} />
          </section>
          <section className="absolute h-32 left-0 right-0 bottom-0 p-4">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
          <ToolPanel
            events={events}
            isSessionActive={isSessionActive}
          />
        </section>
      </main>
    </>
  );
}
