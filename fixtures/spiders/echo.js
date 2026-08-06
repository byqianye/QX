const state = {
  ext: null,
};

const spider = {
  init(ext) {
    state.ext = ext;
    return { initialized: true };
  },

  home() {
    return { method: "home", ext: state.ext };
  },

  search(word, quick) {
    const response = JSON.parse(req("https://probe.invalid/search"));
    return {
      method: "search",
      word,
      quick,
      response,
    };
  },

  player(flag, id) {
    return { method: "player", flag, id };
  },
};

export function __jsEvalReturn() {
  return spider;
}

export default spider;
