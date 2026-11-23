function liveTextModelOptions(model) {
  return model === 'gpt-6-luna' ? {reasoning: {effort: 'none'}} : {temperature: 0};
}

module.exports = {liveTextModelOptions};
