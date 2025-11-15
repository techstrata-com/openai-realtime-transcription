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
  const transcriptionText = useRef("");
  const currentTranscriptionId = useRef(null);
  const promptSentForSession = useRef(false);

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
    const model = "gpt-realtime-transcribe";
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

  // Send a text message to the model
  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        console.log("Event received:", event);

        // Handle speech started events - reset transcription tracking and send prompt
        if (event.type === "input_audio_buffer.speech_started") {
          transcriptionText.current = "";
          currentTranscriptionId.current = event.event_id;
          
          // Clear previous transcriptions when new speech starts
          setEvents((prev) => prev.filter((e) => !e.isTranscription));
          
          // Send prompt/instructions when audio input starts (STT only - no response needed)
          if (!promptSentForSession.current) {
            sendClientEvent({
              type: "session.update",
              session: {
                instructions: "Transcribe text from English voice to Persian (Farsi). Only transcribe, do not respond with audio.",
                modalities: ["text"], // Text only, no audio output
                input_audio_transcription: {
                  model: "whisper-1"
                }
              },
            });
            promptSentForSession.current = true;
          }
        }
        
        // Handle input audio transcription delta events (live updates)
        if (event.type === "input_audio_buffer.transcription.delta" && event.delta) {
          transcriptionText.current += event.delta;
          const transcriptionEvent = {
            type: "input_audio_buffer.transcription.live",
            event_id: currentTranscriptionId.current || event.event_id,
            text: transcriptionText.current,
            timestamp: event.timestamp || new Date().toLocaleTimeString(),
            isTranscription: true,
            isInput: true,
          };
          setEvents((prev) => {
            const filtered = prev.filter(
              (e) => !(e.isTranscription && e.isInput && e.event_id === transcriptionEvent.event_id)
            );
            return [transcriptionEvent, ...filtered];
          });
          return; // Don't add the raw delta event to the log
        }
        
        // STT only - no output transcription handling needed
        // Handle input audio transcription completed events (Persian/Farsi transcription)
        // Check for conversation items with transcribed text
        if (event.type === "conversation.item.input_audio_transcription.completed" || 
            (event.type === "conversation.item.create" && 
             event.item?.content?.some(c => c.type === "input_audio_transcription"))) {
          const transcriptContent = event.item?.content?.find(c => c.type === "input_audio_transcription");
          const transcriptText = transcriptContent?.transcript || event.transcript;
          
          if (transcriptText) {
            const transcriptionEvent = {
              type: "input_audio_transcription.completed",
              event_id: event.event_id,
              text: transcriptText,
              timestamp: event.timestamp || new Date().toLocaleTimeString(),
              isTranscription: true,
              isInput: true,
            };
            setEvents((prev) => {
              const filtered = prev.filter(
                (e) => !(e.isTranscription && e.isInput && e.event_id === transcriptionEvent.event_id)
              );
              return [transcriptionEvent, ...filtered];
            });
            transcriptionText.current = "";
            currentTranscriptionId.current = null;
            return; // Don't add the original event again
          }
        }
        
        // Handle any other input transcription events with transcript field
        if (event.transcript && 
            !event.type?.includes("response") && 
            !event.type?.includes("output_audio") &&
            (event.type?.includes("input_audio") || event.type?.includes("transcription"))) {
          const transcriptionEvent = {
            type: event.type || "input_audio_transcription.completed",
            event_id: event.event_id,
            text: event.transcript,
            timestamp: event.timestamp || new Date().toLocaleTimeString(),
            isTranscription: true,
            isInput: true,
          };
          setEvents((prev) => {
            const filtered = prev.filter(
              (e) => !(e.isTranscription && e.isInput && e.event_id === transcriptionEvent.event_id)
            );
            return [transcriptionEvent, ...filtered];
          });
          transcriptionText.current = "";
          currentTranscriptionId.current = null;
          return; // Don't add the original event again
        }

        setEvents((prev) => [event, ...prev]);
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        transcriptionText.current = "";
        currentTranscriptionId.current = null;
        promptSentForSession.current = false;
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
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
          <ToolPanel
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
        </section>
      </main>
    </>
  );
}
