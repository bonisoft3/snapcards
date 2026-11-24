return {
  invariant: (state) =>
    state.card_index >= 0 &&
    state.mastered >= 0 &&
    state.total >= 1,
  project: (state) => ({
    status: state.status,
    flipped: state.flipped
  }),
  initial: () => ({
    phase: "active",
    flipped: "no",
    status: "playing",
    card_index: 0,
    mastered: 0,
    total: 5,
    paper: "a4",
    card_size: "standard",
    layout: "fold",
    cut_lines: "yes",
    orientation: "portrait"
  }),
  selectDeck: ({context: state, event}) => ({
    ...state,
    card_index: event.card_index,
    flipped: "no",
    mastered: 0,
    total: event.total > 0 ? event.total : 5,
    status: "playing"
  }),
  flipCard: ({context: state, event}) => ({
    ...state,
    flipped: event.flipped === "yes" ? "no" : "yes"
  }),
  nextCard: ({context: state, event}) => {
    const nextIdx = event.card_index + 1;
    const total = event.total > 0 ? event.total : 5;
    if (nextIdx >= total) {
      return {
        ...state,
        status: "completed"
      };
    }
    return {
      ...state,
      card_index: nextIdx,
      flipped: "no",
      status: "playing"
    };
  },
  prevCard: ({context: state, event}) => {
    const currentIdx = event.card_index;
    const prevIdx = Math.max(0, currentIdx - 1);
    return {
      ...state,
      card_index: prevIdx,
      flipped: "no",
      status: "playing"
    };
  },
  masterCard: ({context: state, event}) => {
    const nextIdx = event.card_index + 1;
    const total = event.total > 0 ? event.total : 5;
    const mastered = Math.min(total, Math.min(1000, event.mastered + 1));
    const isDone = nextIdx >= total;
    return {
      ...state,
      card_index: isDone ? event.card_index : nextIdx,
      mastered,
      flipped: "no",
      status: isDone ? "completed" : "playing"
    };
  },
  restartSession: ({context: state, event}) => ({
    ...state,
    card_index: event.card_index,
    flipped: "no",
    mastered: 0,
    total: event.total > 0 ? event.total : 5,
    status: "playing"
  }),
  configurePrint: ({context: state, event}) => {
    const param = event.param;
    if (param === "paper") {
      return {
        ...state,
        paper: state.paper === "a4" ? "letter" : "a4"
      };
    }
    if (param === "orientation") {
      return {
        ...state,
        orientation: state.orientation === "landscape" ? "portrait" : "landscape"
      };
    }
    if (param === "size") {
      const nextSize =
        state.card_size === "standard"
          ? "jumbo"
          : state.card_size === "jumbo"
          ? "poster"
          : state.card_size === "poster"
          ? "mini"
          : "standard";
      return {
        ...state,
        card_size: nextSize
      };
    }
    if (param === "grid") {
      const cur = state.layout || "fold";
      const nextLayout =
        cur === "fold"
          ? "duplex_h"
          : cur === "duplex_h"
          ? "duplex_v"
          : cur === "duplex_v"
          ? "fold"
          : cur === "2x2"
          ? "3x3"
          : "2x2";
      return {
        ...state,
        layout: nextLayout
      };
    }
    if (param === "lines") {
      return {
        ...state,
        cut_lines: state.cut_lines === "yes" ? "no" : "yes"
      };
    }
    return state;
  }
};
