class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pendingSamples = [];
    this.pendingSampleCount = 0;
    this.targetSampleCount = Math.max(1, Math.round(sampleRate * 0.1));
  }

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

      this.pendingSamples.push(output);
      this.pendingSampleCount += output.length;

      while (this.pendingSampleCount >= this.targetSampleCount) {
        const batch = new Float32Array(this.targetSampleCount);
        let writeOffset = 0;
        while (writeOffset < batch.length && this.pendingSamples.length > 0) {
          const first = this.pendingSamples[0];
          const takeCount = Math.min(first.length, batch.length - writeOffset);
          batch.set(first.subarray(0, takeCount), writeOffset);
          writeOffset += takeCount;
          if (takeCount === first.length) {
            this.pendingSamples.shift();
          } else {
            this.pendingSamples[0] = first.slice(takeCount);
          }
          this.pendingSampleCount -= takeCount;
        }
        this.port.postMessage(batch, [batch.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
