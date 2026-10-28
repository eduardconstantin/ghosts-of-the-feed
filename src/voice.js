let audioContext;
let sourceNode;

export function unlockAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  audioContext = audioContext || new Context();
  if (audioContext.state === "suspended") audioContext.resume();
}

export function stopVoice() {
  sourceNode?.stop();
  sourceNode = null;
  window.speechSynthesis?.cancel();
}

export async function speakGhost(text) {
  stopVoice();
  const ready = await fetch("/api/voice")
    .then((response) => response.json())
    .catch(() => ({ eleven: false }));

  if (ready.eleven) {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || "ElevenLabs could not speak.");
    }
    await playMp3(await response.arrayBuffer());
    return "elevenlabs";
  }

  speakWithBrowser(text);
  return "browser";
}

function speakWithBrowser(text) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.9;
  utterance.pitch = 0.7;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

async function playMp3(bytes) {
  unlockAudio();
  if (!audioContext) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    const audio = new Audio(url);
    await audio.play();
    return;
  }
  const buffer = await audioContext.decodeAudioData(bytes.slice(0));
  sourceNode = audioContext.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.connect(audioContext.destination);
  sourceNode.start();
}
