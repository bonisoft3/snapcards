// The accepted deck and run travel with a browser reply so a late result cannot
// materialize into a newer request with the same topic.

const LEXICON = {
  pt: {
    danca: ["Valsa", "Ciranda", "Baião", "Quadrilha", "Maxixe"],
    fazenda: ["Bezerro", "Potro", "Leitão", "Pintinho", "Cordeiro"],
    instrument: ["Cavaquinho", "Sanfona", "Pandeiro", "Berimbau", "Agogô"],
    anima: ["Capivara", "Tamanduá", "Tatu", "Preguiça", "Tucano"],
    fruta: ["Caju", "Goiaba", "Jabuticaba", "Pitanga", "Acerola"],
    planeta: ["Mercúrio", "Vênus", "Júpiter", "Netuno", "Cometa"],
    espacia: ["Asteroide", "Nebulosa", "Galáxia", "Constelação", "Órbita"],
    quadrinho: ["Roteiro", "Nanquim", "Vinheta", "Caricatura", "Fanzine"],
    cotidiano: ["Mesa", "Cadeira", "Relógio", "Janela", "Chave"],
    alfabeto: ["Abelha", "Bola", "Dado", "Estrela", "Foca"],
    carro: ["Conversível", "Cupê", "Sedã", "Picape", "Utilitário"],
    comida: ["Pão de Queijo", "Tapioca", "Acarajé", "Moqueca", "Brigadeiro"],
    esporte: ["Natação", "Atletismo", "Vôlei", "Ginástica", "Ciclismo"],
    profiss: ["Bombeiro", "Professor", "Médico", "Padeiro", "Astronauta"],
    mar: ["Baleia", "Golfinho", "Polvo", "Cavalo-Marinho", "Tartaruga"],
    dino: ["Triceratops", "Estegossauro", "Pterodáctilo", "Diplodoco", "Velociraptor"],
    corpo: ["Coração", "Pulmão", "Cérebro", "Esqueleto", "Músculo"],
    escola: ["Caderno", "Lápis", "Mochila", "Quadro", "Borracha"],
    flor: ["Girassol", "Orquídea", "Rosa", "Margarida", "Ipê"],
    marcial: ["Judô", "Karatê", "Capoeira", "Jiu-Jitsu", "Taekwondo"],
  },
  es: {
    danca: ["Vals", "Cumbia", "Joropo", "Cueca", "Marinera"],
    fazenda: ["Ternero", "Potro", "Lechón", "Pollito", "Cordero"],
    instrument: ["Charango", "Maracas", "Acordeón", "Cajón", "Quena"],
    anima: ["Carpincho", "Oso Hormiguero", "Armadillo", "Perezoso", "Tucán"],
    fruta: ["Guayaba", "Maracuyá", "Papaya", "Chirimoya", "Tuna"],
    planeta: ["Mercurio", "Venus", "Júpiter", "Neptuno", "Cometa"],
    espacia: ["Asteroide", "Nebulosa", "Galaxia", "Constelación", "Órbita"],
    quadrinho: ["Guion", "Tinta", "Viñeta", "Caricatura", "Fanzine"],
    cotidiano: ["Mesa", "Silla", "Reloj", "Ventana", "Llave"],
    alfabeto: ["Abeja", "Barco", "Dado", "Estrella", "Foca"],
    carro: ["Convertible", "Cupé", "Sedán", "Camioneta", "Utilitario"],
    comida: ["Arepa", "Empanada", "Tamal", "Ceviche", "Churro"],
    esporte: ["Natación", "Atletismo", "Voleibol", "Gimnasia", "Ciclismo"],
    profiss: ["Bombero", "Maestro", "Médico", "Panadero", "Astronauta"],
    mar: ["Ballena", "Delfín", "Pulpo", "Caballito de Mar", "Tortuga"],
    dino: ["Triceratops", "Estegosaurio", "Pterodáctilo", "Diplodocus", "Velociraptor"],
    corpo: ["Corazón", "Pulmón", "Cerebro", "Esqueleto", "Músculo"],
    escola: ["Cuaderno", "Lápiz", "Mochila", "Pizarra", "Borrador"],
    flor: ["Girasol", "Orquídea", "Rosa", "Margarita", "Jazmín"],
    marcial: ["Judo", "Kárate", "Capoeira", "Jiu-Jitsu", "Taekwondo"],
  },
  en: {
    danca: ["Waltz", "Swing", "Polka", "Minuet", "Square Dance"],
    fazenda: ["Calf", "Foal", "Piglet", "Chick", "Lamb"],
    instrument: ["Banjo", "Harmonica", "Tambourine", "Ukulele", "Xylophone"],
    anima: ["Capybara", "Anteater", "Armadillo", "Sloth", "Toucan"],
    fruta: ["Guava", "Papaya", "Passionfruit", "Lychee", "Fig"],
    planeta: ["Mercury", "Venus", "Jupiter", "Neptune", "Comet"],
    espacia: ["Asteroid", "Nebula", "Galaxy", "Constellation", "Orbit"],
    quadrinho: ["Storyboard", "Ink Brush", "Panel", "Caricature", "Zine"],
    cotidiano: ["Table", "Chair", "Clock", "Window", "Key"],
    alfabeto: ["Apple", "Boat", "Cat", "Drum", "Elephant"],
    carro: ["Convertible", "Coupe", "Sedan", "Pickup Truck", "Hatchback"],
    comida: ["Pancake", "Pretzel", "Waffle", "Muffin", "Croissant"],
    esporte: ["Swimming", "Track", "Volleyball", "Gymnastics", "Cycling"],
    profiss: ["Firefighter", "Teacher", "Doctor", "Baker", "Astronaut"],
    mar: ["Whale", "Dolphin", "Octopus", "Seahorse", "Sea Turtle"],
    dino: ["Triceratops", "Stegosaurus", "Pterodactyl", "Diplodocus", "Velociraptor"],
    corpo: ["Heart", "Lung", "Brain", "Skeleton", "Muscle"],
    escola: ["Notebook", "Pencil", "Backpack", "Chalkboard", "Eraser"],
    flor: ["Sunflower", "Orchid", "Rose", "Daisy", "Tulip"],
    marcial: ["Judo", "Karate", "Capoeira", "Jiu-Jitsu", "Taekwondo"],
  },
  he: {
    danca: ["ואלס", "הורה", "דבקה", "פולקה", "ריקוד עם"],
    fazenda: ["עגל", "סייח", "חזרזיר", "אפרוח", "טלה"],
    instrument: ["מנדולינה", "אקורדיון", "דרבוקה", "נבל", "קסילופון"],
    anima: ["קפיבארה", "דוב נמלים", "ארמדיל", "עצלן", "טוקן"],
    fruta: ["גויאבה", "פפאיה", "פסיפלורה", "ליצ׳י", "תאנה"],
    planeta: ["חמה", "נוגה", "צדק", "נפטון", "שביט"],
    espacia: ["אסטרואיד", "ערפילית", "גלקסיה", "קבוצת כוכבים", "מסלול"],
    quadrinho: ["תסריט", "דיו", "משבצת", "קריקטורה", "חוברת"],
    cotidiano: ["שולחן", "כיסא", "שעון", "חלון", "מפתח"],
    alfabeto: ["אריה", "בלון", "גמל", "דלת", "הר"],
    carro: ["קבריולה", "קופה", "סדאן", "טנדר", "מסחרית"],
    comida: ["פלאפל", "חומוס", "חלה", "שקשוקה", "סופגנייה"],
    esporte: ["שחייה", "אתלטיקה", "כדורעף", "התעמלות", "רכיבה"],
    profiss: ["כבאי", "מורה", "רופא", "אופה", "אסטרונאוט"],
    mar: ["לווייתן", "דולפין", "תמנון", "סוסון ים", "צב ים"],
    dino: ["טריצרטופס", "סטגוזאורוס", "פטרודקטיל", "דיפלודוקוס", "ולוצירפטור"],
    corpo: ["לב", "ריאה", "מוח", "שלד", "שריר"],
    escola: ["מחברת", "עיפרון", "ילקוט", "לוח", "מחק"],
    flor: ["חמנייה", "סחלב", "ורד", "חרצית", "כלנית"],
    marcial: ["ג׳ודו", "קראטה", "קפוארה", "ג׳יו-ג׳יטסו", "טאקוונדו"],
  },
  zh: {
    danca: ["华尔兹", "秧歌", "波尔卡", "扇子舞", "圆圈舞"],
    fazenda: ["小牛", "小马驹", "小猪仔", "小鸡", "小羊羔"],
    instrument: ["琵琶", "二胡", "手鼓", "古筝", "木琴"],
    anima: ["水豚", "食蚁兽", "犰狳", "树懒", "巨嘴鸟"],
    fruta: ["番石榴", "木瓜", "百香果", "荔枝", "无花果"],
    planeta: ["水星", "金星", "木星", "海王星", "彗星"],
    espacia: ["小行星", "星云", "星系", "星座", "轨道"],
    quadrinho: ["分镜", "墨水笔", "画格", "漫画肖像", "画册"],
    cotidiano: ["桌子", "椅子", "时钟", "窗户", "钥匙"],
    alfabeto: ["苹果", "小船", "猫咪", "大鼓", "大象"],
    carro: ["敞篷车", "双门轿跑", "轿车", "皮卡", "旅行车"],
    comida: ["饺子", "包子", "春卷", "汤圆", "月饼"],
    esporte: ["游泳", "田径", "排球", "体操", "自行车"],
    profiss: ["消防员", "教师", "医生", "面包师", "宇航员"],
    mar: ["鲸鱼", "海豚", "章鱼", "海马", "海龟"],
    dino: ["三角龙", "剑龙", "翼龙", "梁龙", "迅猛龙"],
    corpo: ["心脏", "肺", "大脑", "骨骼", "肌肉"],
    escola: ["笔记本", "铅笔", "书包", "黑板", "橡皮"],
    flor: ["向日葵", "兰花", "玫瑰", "雏菊", "牡丹"],
    marcial: ["柔道", "空手道", "卡波耶拉", "柔术", "跆拳道"],
  },
};

const FACETS = {
  pt: ["Origem", "Tradição", "Símbolo", "Costume", "Patrimônio"],
  es: ["Origen", "Tradición", "Símbolo", "Costumbre", "Patrimonio"],
  en: ["Origin", "Tradition", "Symbol", "Heritage", "Craft"],
  he: ["מקור", "מסורת", "סמל", "מנהג", "מורשת"],
  zh: ["起源", "传统", "象征", "习俗", "文化"],
};

const CATEGORY_LABELS = {
  pt: {
    danca: "Dança & Ritmos",
    fazenda: "Vida no Campo",
    instrument: "Música",
    anima: "Fauna",
    fruta: "Frutas & Botânica",
    planeta: "Astronomia",
    espacia: "Espaço",
    quadrinho: "Arte & Quadrinhos",
    cotidiano: "Cotidiano",
    alfabeto: "Alfabeto",
    carro: "Automotivo",
    comida: "Gastronomia",
    esporte: "Esportes",
    profiss: "Profissões",
    mar: "Vida Marinha",
    dino: "Paleontologia",
    corpo: "Anatomia",
    escola: "Educação",
    flor: "Botânica",
    marcial: "Artes Marciais",
    default: "Cultura & Exploração",
  },
  es: {
    danca: "Danza y Ritmos",
    fazenda: "Granja",
    instrument: "Música",
    anima: "Fauna",
    fruta: "Frutas",
    planeta: "Astronomía",
    espacia: "Espacio",
    quadrinho: "Arte y Cómics",
    cotidiano: "Cotidiano",
    alfabeto: "Alfabeto",
    carro: "Automotriz",
    comida: "Gastronomía",
    esporte: "Deportes",
    profiss: "Profesiones",
    mar: "Vida Marina",
    dino: "Paleontología",
    corpo: "Anatomía",
    escola: "Educación",
    flor: "Botánica",
    marcial: "Artes Marciales",
    default: "Cultura y Exploración",
  },
  en: {
    danca: "Dance & Rhythm",
    fazenda: "Farm Life",
    instrument: "Music",
    anima: "Wildlife",
    fruta: "Fruits",
    planeta: "Astronomy",
    espacia: "Space",
    quadrinho: "Comics & Art",
    cotidiano: "Everyday Life",
    alfabeto: "Alphabet",
    carro: "Automotive",
    comida: "Culinary",
    esporte: "Sports",
    profiss: "Professions",
    mar: "Marine Life",
    dino: "Paleontology",
    corpo: "Anatomy",
    escola: "Education",
    flor: "Botany",
    marcial: "Martial Arts",
    default: "Cultural Exploration",
  },
  he: {
    danca: "מחול ומוזיקה",
    fazenda: "חיי חווה",
    instrument: "מוזיקה",
    anima: "טבע ובעלי חיים",
    fruta: "פירות",
    planeta: "אסטרונומיה",
    espacia: "חלל",
    quadrinho: "אמנות וקומיקס",
    cotidiano: "חיי יומיום",
    alfabeto: "אלפבית",
    carro: "כלי רכב",
    comida: "קולינריה",
    esporte: "ספורט",
    profiss: "מקצועות",
    mar: "חיים ימיים",
    dino: "פלאונטולוגיה",
    corpo: "אנטומיה",
    escola: "חינוך",
    flor: "בוטניקה",
    marcial: "אמנויות לחימה",
    default: "תרבות וחקר",
  },
  zh: {
    danca: "舞蹈与律动",
    fazenda: "农场生活",
    instrument: "音乐",
    anima: "自然动物",
    fruta: "水果植物",
    planeta: "天文学",
    espacia: "太空探索",
    quadrinho: "漫画艺术",
    cotidiano: "日常生活",
    alfabeto: "字母启蒙",
    carro: "交通工具",
    comida: "美食文化",
    esporte: "体育运动",
    profiss: "职业认知",
    mar: "海洋生物",
    dino: "古生物恐龙",
    corpo: "人体结构",
    escola: "校园学习",
    flor: "花卉植物",
    marcial: "武术运动",
    default: "文化探索",
  },
};

function resolveLangKey(locale) {
  const lc = String(locale || "Português").toLowerCase().trim();
  if (lc.startsWith("es") || lc.includes("españ") || lc.includes("espan")) return "es";
  if (lc.startsWith("en") || lc.includes("engl") || lc.includes("ingl")) return "en";
  if (lc.startsWith("he") || lc.includes("עבר") || lc.includes("hebr")) return "he";
  if (lc.startsWith("zh") || lc.includes("中文") || lc.includes("汉语") || lc.includes("chin") || lc.includes("mandar")) return "zh";
  return "pt";
}

function classifyTopic(topic) {
  const t = String(topic || "").toLowerCase();
  if (t.includes("marcia") || t.includes("martial") || /\blutas?\b/.test(t) || t.includes("karat") || t.includes("judo") || t.includes("judô") || t.includes("אמנויות לחימה") || t.includes("武术")) return "marcial";
  if (t.includes("danç") || t.includes("danc") || t.includes("bail") || t.includes("ritmo") || t.includes("ריקוד") || t.includes("舞")) return "danca";
  if (t.includes("fazenda") || t.includes("farm") || t.includes("granja") || t.includes("חווה") || t.includes("农场")) return "fazenda";
  if (t.includes("instrument") || t.includes("orquestra") || t.includes("músic") || t.includes("music") || t.includes("כלי") || t.includes("乐器")) return "instrument";
  if (t.includes("anima") || t.includes("fauna") || t.includes("wildlife") || t.includes("bicho") || t.includes("חיות") || t.includes("动物")) return "anima";
  if (t.includes("fruta") || t.includes("fruit") || t.includes("פירות") || t.includes("水果")) return "fruta";
  if (t.includes("planeta") || t.includes("estrela") || t.includes("solar") || t.includes("planet") || t.includes("כוכב") || t.includes("行星")) return "planeta";
  if (t.includes("espacia") || t.includes("space") || t.includes("foguete") || t.includes("astron") || t.includes("חלל") || t.includes("太空")) return "espacia";
  if (t.includes("quadrinho") || t.includes("revista") || t.includes("comic") || t.includes("mangá") || t.includes("קומיקס") || t.includes("漫画")) return "quadrinho";
  if (t.includes("cotidiano") || t.includes("daily") || /\bcasa\b/.test(t) || /\bhome\b/.test(t) || t.includes("יומיום") || t.includes("日常")) return "cotidiano";
  if (t.includes("alfabeto") || t.includes("letra") || t.includes("alphabet") || t.includes("אלפבית") || t.includes("字母")) return "alfabeto";
  if (/\bcarros?\b/.test(t) || t.includes("veículo") || t.includes("veiculo") || /\bautos?\b/.test(t) || /\bcars?\b/.test(t) || t.includes("autom") || t.includes("מכונית") || t.includes("汽车")) return "carro";
  if (t.includes("comida") || t.includes("culin") || t.includes("prato") || t.includes("food") || t.includes("אוכל") || t.includes("美食")) return "comida";
  if (t.includes("esporte") || t.includes("jogo") || t.includes("sport") || t.includes("ספורט") || t.includes("运动")) return "esporte";
  if (t.includes("profiss") || t.includes("trabalh") || /\bjobs?\b/.test(t) || t.includes("מקצוע") || t.includes("职业")) return "profiss";
  if (/\bmar\b/.test(t) || t.includes("marinh") || t.includes("oceano") || t.includes("peixe") || t.includes("ocean") || t.includes("ים") || t.includes("海洋")) return "mar";
  if (t.includes("dino") || t.includes("fóssil") || t.includes("juráss") || t.includes("דינוזאור") || t.includes("恐龙")) return "dino";
  if (t.includes("corpo") || t.includes("anatomia") || /\bbody\b/.test(t) || t.includes("גוף") || t.includes("身体")) return "corpo";
  if (t.includes("escola") || /\baulas?\b/.test(t) || t.includes("school") || t.includes("בית ספר") || t.includes("学校")) return "escola";
  if (/\bflor(es)?\b/.test(t) || t.includes("planta") || t.includes("árvore") || t.includes("flower") || t.includes("פרח") || t.includes("花")) return "flor";
  return "";
}

function sanitizeDetailValue(s) {
  return String(s || "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .trim()
    .slice(0, 128);
}

function synthesizeBrowserWords(topic, locale) {
  const cleanTopic = sanitizeDetailValue(String(topic || "Instrumentos Musicais").split("::")[0]) || "Instrumentos Musicais";
  const lang = resolveLangKey(locale);
  const bucket = classifyTopic(cleanTopic);
  const table = LEXICON[lang] || LEXICON.pt;
  if (bucket && Array.isArray(table[bucket])) {
    return table[bucket].slice(0, 5).map((w) => sanitizeDetailValue(w));
  }
  const facets = FACETS[lang] || FACETS.pt;
  const headWord = cleanTopic.split(/\s+/)[0] || cleanTopic;
  return facets.map((facet) => sanitizeDetailValue(`${headWord} · ${facet}`));
}

function approximateCityGeo(locale) {
  let tz = "";
  try {
    tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  } catch (_err) {
    tz = "";
  }
  const lang = resolveLangKey(locale);
  if (lang === "es") return { cityRegion: "Cidade do México, México", languageName: "Español", defaultTopic: "Fauna de Sudamérica" };
  if (lang === "en") return { cityRegion: "New York, USA", languageName: "English", defaultTopic: "Amazon Rainforest Wildlife" };
  if (lang === "he") return { cityRegion: "תל אביב, ישראל", languageName: "עברית", defaultTopic: "חיות בר ואמזונס" };
  if (lang === "zh") return { cityRegion: "北京, 中国", languageName: "中文", defaultTopic: "南美与自然野生动物" };
  if (tz.includes("Recife") || tz.includes("Fortaleza") || tz.includes("Bahia")) {
    return { cityRegion: "Recife, Brasil", languageName: "Português", defaultTopic: "Animais Brasileiros" };
  }
  if (tz.includes("Manaus") || tz.includes("Belem")) {
    return { cityRegion: "Manaus, Brasil", languageName: "Português", defaultTopic: "Animais Brasileiros" };
  }
  if (tz.includes("Lisbon")) {
    return { cityRegion: "Lisboa, Portugal", languageName: "Português", defaultTopic: "Animais Brasileiros" };
  }
  return { cityRegion: "São Paulo, Brasil", languageName: "Português", defaultTopic: "Animais Brasileiros" };
}

function synthesizeBrowserDefaults(topic, locale) {
  const cleanTopic = sanitizeDetailValue(String(topic || "Animais Brasileiros").split("::")[0]) || "Animais Brasileiros";
  const lang = resolveLangKey(locale);
  const bucket = classifyTopic(cleanTopic);
  const catTable = CATEGORY_LABELS[lang] || CATEGORY_LABELS.pt;
  const categoryDefault = sanitizeDetailValue((bucket && catTable[bucket]) || catTable.default || "Fauna");
  const tLower = cleanTopic.toLowerCase();
  const audienceByLang = {
    pt: tLower.includes("alfabeto") || tLower.includes("fruta") || tLower.includes("fazenda")
      ? "Primeira Infância (2–5)"
      : tLower.includes("anatomia") || tLower.includes("quadrinho") || tLower.includes("presiden")
      ? "Jovens & Adultos"
      : "Crianças (6–10)",
    es: "Niños (6–10)",
    en: "Kids (6–10)",
    he: "ילדים (6–10)",
    zh: "儿童 (6–10岁)",
  };
  const audienceDefault = sanitizeDetailValue(audienceByLang[lang] || audienceByLang.pt);
  const geo = approximateCityGeo(locale);
  return {
    categoryDefault,
    audienceDefault,
    languageDefault: sanitizeDetailValue(geo.languageName),
    regionDefault: sanitizeDetailValue(geo.cityRegion),
    topicDefault: sanitizeDetailValue(geo.defaultTopic),
  };
}

let lastDispatchedKey = "";

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "pronto:props") return;
  const props = msg.props || {};
  const topic = sanitizeDetailValue(props.topic);
  const locale = sanitizeDetailValue(props.locale || "Português");
  const status = sanitizeDetailValue(props.status || "idle");
  const run = sanitizeDetailValue(props.run);
  const set_id = sanitizeDetailValue(props.set_id);
  if (!topic || !locale || (status !== "idle" && status !== "generating")) return;
  const dispatchKey = `${topic}|${locale}|${status}|${set_id}|${run}`;
  if (dispatchKey === lastDispatchedKey) return;
  lastDispatchedKey = dispatchKey;

  const words = synthesizeBrowserWords(topic, locale);
  const defaults = synthesizeBrowserDefaults(topic, locale);

  // Always upsert the pre-computed 5 card words under `status: "generating"` so
  // clicking "Criar Coleção" has instant zero-latency access to the 5 card concepts.
  self.postMessage({
    type: "pronto:event",
    name: "draft",
    detail: {
      topic,
      locale,
      status: "generating",
      set_id,
      run,
      w0: words[0] || `${topic} · I`,
      w1: words[1] || `${topic} · II`,
      w2: words[2] || `${topic} · III`,
      w3: words[3] || `${topic} · IV`,
      w4: words[4] || `${topic} · V`,
    },
  });

  // When `status === "idle"`, also upsert the browser-model grayed defaults under
  // `status: "idle"` so empty form inputs display them and `Tab` auto-completes them.
  if (status === "idle") {
    self.postMessage({
      type: "pronto:event",
      name: "draft",
      detail: {
        topic,
        locale,
        status: "idle",
        set_id,
        run,
        w0: defaults.categoryDefault,
        w1: defaults.audienceDefault,
        w2: defaults.languageDefault,
        w3: defaults.regionDefault,
        w4: defaults.topicDefault,
      },
    });
  }
});

self.postMessage({ type: "pronto:ready" });
