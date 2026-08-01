export type SemanticDomain =
  | "al7an"
  | "taqs"
  | "tari5"
  | "saints"
  | "coptic"
  | "bible"
  | "ta3lim"
  | "school";

export type DomainRoute = {
  domains: SemanticDomain[];
  scores: Record<SemanticDomain, number>;
  strictDomains?: boolean;
};

const ALL_DOMAINS: SemanticDomain[] = [
  "al7an",
  "taqs",
  "tari5",
  "saints",
  "coptic",
  "bible",
  "ta3lim",
  "school",
];

const DOMAIN_TERMS: Record<SemanticDomain, string[]> = {
  al7an: ["hymn", "tune", "melody", "لحن", "الحان", "مرد", "ذكصولوجيه", "تسبحه"],
  taqs: ["طقس", "قداس", "افخارستيا", "إفخارستيا", "بخور", "الصوم الكبير", "صوم الرسل", "اصوام", "الاصوام", "عيد", "اعياد", "اسرار", "أسرار", "كنسيات", "شمامسه", "شماس", "شمامس", "ابصالتس", "ابسالتس", "اغنسطس", "دياكون", "ذياكون", "رتب الشمامسه", "رفع بخور عشية و باكر", "رفع بخور عشية وباكر", "لبس التونية و المزامير", "لبس التونية", "تقديم الحمل", "اختيار الحمل", "طبق الحمل", "قربان", "قربانه", "قربانات", "قداس الموعوظين", "صلاة الصلح", "الأنافورا", "انافورا", "قدوس", "تجسد و تأنس", "التقديس", "الأواشي و الطلبات", "الاواشي والطلبات", "المجمع و الترحيم", "المجمع والترحيم", "القسمة", "سر المعمودية", "سر الميرون", "سر التوبة", "سر الاعتراف", "سر التوبة والاعتراف", "سر الإفخارستيا", "سر الافخارستيا", "سر التناول", "سر مسحة المرضى", "سر القنديل", "سر الزيجة", "سر الإكليل", "طقس الإكليل", "صلاة الإكليل", "حلول السر", "سر الكهنوت", "الإبروسفارين", "ابروسفارين"],
  tari5: ["تاريخ", "عقيده", "مجمع", "مجامع", "الايمان", "كنيسه", "لاهوت", "البابا", "بطرك", "بطريرك", "اثناسيوس", "كيرلس", "اريوسيه", "اريوس", "نسطور", "عمود الدين", "ابطال الايمان"],
  saints: ["سنكسار", "قديس", "قديسه", "شهيد", "سيره"],
  coptic: ["coptic", "قبطي", "قواعد", "لغه قبطي", "لغقة قبطية", "حروف"],
  bible: [
    "bible",
    "cartoon",
    "كارتون",
    "genesis",
    "verse",
    "verses",
    "كتاب",
    "ايات",
    "سفر",
    "اصحاح",
    "تكوين",
    "خروج",
    "لاويين",
    "عدد",
    "تثنيه",
    "يشوع",
    "قضاه",
    "راعوث",
    "صموئيل",
    "ملوك",
    "اخبار الايام",
    "عزرا",
    "نحميا",
    "استير",
    "ايوب",
    "مزامير",
    "مزمور",
    "امثال",
    "جامعه",
    "نشيد الانشاد",
    "اشعياء",
    "ارميا",
    "مراثي ارميا",
    "حزقيال",
    "دانيال",
    "هوشع",
    "يوئيل",
    "عاموس",
    "عوبديا",
    "يونان",
    "ميخا",
    "ناحوم",
    "حبقوق",
    "صفنيا",
    "حجي",
    "زكريا",
    "ملاخي",
    "متى",
    "مرقس",
    "لوقا",
    "يوحنا",
    "اعمال الرسل",
    "روميه",
    "كورنثوس",
    "غلاطيه",
    "افسس",
    "فيلبي",
    "كولوسي",
    "تسالونيكي",
    "تيموثاوس",
    "تيطس",
    "فليمون",
    "عبرانيين",
    "يعقوب",
    "بطرس",
    "يهوذا",
    "رؤيا",
    "انجيل",
    "بولس",
    "رساله",
  ],
  ta3lim: ["وعظه", "تعليم", "تامل", "توبه", "خدمه", "محبه", "فضيله", "اباء", "نتعلم", "دروس"],
  school: ["school", "مدرسة الشمامسة", "عن المدرسة", "كتب المدرسة", "مناهج المدرسة", "كتب ومناهج", "اشعارات", "إشعارات", "notifications", "كلمنا"],
};

const BROAD_FEAST_TERMS = ["عيد", "اعياد", "الميلاد", "الغطاس", "القيامه", "التجسد"];
const NORMALIZED_DOMAIN_TERMS = Object.fromEntries(
  ALL_DOMAINS.map((domain) => [domain, DOMAIN_TERMS[domain].map(normalizeQuery)]),
) as Record<SemanticDomain, string[]>;
const NORMALIZED_BROAD_FEAST_TERMS: string[] = BROAD_FEAST_TERMS.map(normalizeQuery);
const AMBIGUOUS_TA3LIM_TERMS = new Set(
  ["خدمه", "محبه", "فضيله", "اباء"].map(normalizeQuery),
);

export function routeRetrievalDomains(query: string): DomainRoute {
  const normalized = normalizeQuery(query);
  const scores = Object.fromEntries(ALL_DOMAINS.map((domain) => [domain, 0])) as Record<
    SemanticDomain,
    number
  >;
  let strictDomains = false;
  let hasAmbiguousTa3limSignal = false;

  for (const domain of ALL_DOMAINS) {
    for (const term of NORMALIZED_DOMAIN_TERMS[domain]) {
      if (!normalized.includes(term)) {
        continue;
      }
      if (domain === "ta3lim" && AMBIGUOUS_TA3LIM_TERMS.has(term)) {
        hasAmbiguousTa3limSignal = true;
        continue;
      }
      scores[domain] += term.length > 4 ? 3 : 2;
    }
  }
  if (hasAmbiguousTa3limSignal) {
    scores.ta3lim = Math.max(scores.ta3lim, 1);
  }

  if (hasSaintCommemorationIntent(normalized)) {
    scores.saints += 6;
  }

  const hasBroadFeastTerm = NORMALIZED_BROAD_FEAST_TERMS.some((term) =>
    normalized.includes(term),
  );
  if (hasBroadFeastTerm) {
    scores.taqs += 3;
    scores.bible += 3;
    scores.ta3lim += 3;
  }

  if (scores.taqs > 0 && hasTeachingInterpretationIntent(normalized)) {
    scores.ta3lim += 3;
  }

  if (hasEucharistDoctrineIntent(normalized)) {
    scores.tari5 += 8;
  }

  if (hasOrthodoxTitleLookupIntent(normalized)) {
    scores.tari5 += 3;
  }

  if (scores.coptic > 0) {
    scores.tari5 += 2;
  }

  if (hasMonasticismIntent(normalized)) {
    boostHistoryAndSaints(scores, 6);
  }

  if (hasHistoricalOfficeIntent(normalized)) {
    boostHistoryAndSaints(scores, 5);
  }

  if (hasPersonEpithetLookupIntent(normalized)) {
    boostHistoryAndSaints(scores, 5);
  }

  if (scores.taqs > 0 && hasLiturgicalAuthorshipIntent(normalized)) {
    boostHistoryAndSaints(scores, 8);
    scores.taqs = 0;
    strictDomains = true;
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore < 2) {
    return { domains: ["ta3lim", "bible", "taqs"], scores };
  }

  const domains = new Set(
    ALL_DOMAINS.filter((domain) =>
      hasBroadFeastTerm
        ? scores[domain] >= 3
        : scores[domain] >= Math.max(2, maxScore - 1),
    ),
  );

  if (scores.bible > 0 && scores.ta3lim > 0) {
    domains.add("bible");
    domains.add("ta3lim");
  }

  if (scores.bible > 0 && scores.ta3lim === 0 && scores.bible <= 3) {
    domains.add("ta3lim");
  }

  return { domains: [...domains], scores, strictDomains };
}

function boostHistoryAndSaints(
  scores: Record<SemanticDomain, number>,
  boost: number,
): void {
  const score = Math.max(scores.tari5, scores.saints) + boost;
  scores.tari5 = score;
  scores.saints = score;
}

function hasSaintCommemorationIntent(normalized: string): boolean {
  const directEvents = ["استشهاد", "نياحه", "تذكار"];
  if (directEvents.some((term) => normalized.includes(term))) {
    return true;
  }

  const contextualEvents = ["شهاده", "موت", "انتقال"];
  const saintTitles = ["قديس", "قديسه", "شهيد", "شهيده", "انبا", "البابا", "مار"];
  return contextualEvents.some((term) => normalized.includes(term)) &&
    saintTitles.some((term) => normalized.includes(term));
}

function hasMonasticismIntent(normalized: string): boolean {
  return ["رهبنه", "رهبان", "راهب", "اديره", "دير", "نسك"].some((term) =>
    normalized.includes(term),
  );
}

function hasHistoricalOfficeIntent(normalized: string): boolean {
  return ["والي", "الوالي"].some((term) => normalized.includes(term));
}

function hasPersonEpithetLookupIntent(normalized: string): boolean {
  const identityLookup = ["مين هو", "من هو", "مين هي", "من هي"].some((term) =>
    normalized.includes(term),
  );
  const epithetLanguage = ["اتسمي", "لقب", "الملقب", "المعروف باسم"].some((term) =>
    normalized.includes(term),
  );
  return identityLookup && epithetLanguage;
}

function hasLiturgicalAuthorshipIntent(normalized: string): boolean {
  return [
    "واضع",
    "من وضع",
    "مين وضع",
    "مين اللي وضع",
    "مولف",
    "من الف",
    "مين الف",
  ].some((term) => normalized.includes(term));
}

function hasEucharistDoctrineIntent(normalized: string): boolean {
  return ["افخارستيا", "الافخارستيا"].some((term) => normalized.includes(term));
}

function hasTeachingInterpretationIntent(normalized: string): boolean {
  return ["معني", "نتعلم", "دروس", "تامل"].some((term) => normalized.includes(term));
}

function hasOrthodoxTitleLookupIntent(normalized: string): boolean {
  const mentionsOrthodoxy = ["ارثوذكسيه", "الارثوذكسيه"].some((term) =>
    normalized.includes(term),
  );
  const titleLookup = ["من هو", "من هي", "بطل", "مصباح", "حامي", "المعترف", "مجمع", "عقيدة", "هرطقة"].some((term) =>
    normalized.includes(term),
  );
  return mentionsOrthodoxy && titleLookup;
}

function normalizeQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064a")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064a")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0640/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
