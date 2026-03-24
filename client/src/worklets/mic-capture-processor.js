class MicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inputChannels = inputs?.[0];
    const frameCount = inputChannels?.[0]?.length || 0;

    if (frameCount > 0) {
      const output = new Float32Array(frameCount);
      let activeChannels = 0;

      inputChannels.forEach((channel) => {
        if (!channel || channel.length !== frameCount) return;
        activeChannels += 1;
        for (let index = 0; index < frameCount; index += 1) {
          output[index] += channel[index];
        }
      });

      if (activeChannels > 1) {
        for (let index = 0; index < frameCount; index += 1) {
          output[index] /= activeChannels;
        }
      }

      this.port.postMessage(output);
    }
    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
