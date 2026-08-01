import { describe, expect, test } from "vitest";
import { routeRetrievalDomains } from "../src/domain-router";

describe("routeRetrievalDomains", () => {
  test("routes Bible book and verse questions to bible", () => {
    expect(routeRetrievalDomains("what does genesis say about creation").domains).toContain(
      "bible",
    );
    expect(routeRetrievalDomains("تأملات على الآيات").domains).toContain("bible");
  });

  test("routes hymn and tune questions to al7an", () => {
    expect(routeRetrievalDomains("teach me the hymn tune").domains).toContain("al7an");
    expect(routeRetrievalDomains("لحن ختام الصلاة").domains).toContain("al7an");
  });

  test("routes ritual questions to taqs", () => {
    expect(routeRetrievalDomains("طقس القداس ورفع بخور").domains).toContain("taqs");
  });

  test("routes saint and seneksar questions to saints", () => {
    expect(routeRetrievalDomains("سنكسار اليوم وسيرة القديس").domains).toContain("saints");
  });

  test("routes doctrine and history questions to tari5", () => {
    expect(routeRetrievalDomains("المجامع والعقيدة في تاريخ الكنيسة").domains).toContain(
      "tari5",
    );
  });

  test("routes monastic history questions to history and saint sources", () => {
    const domains = routeRetrievalDomains("إزاي ظهرت الرهبنة في مصر؟").domains;
    expect(domains).toContain("tari5");
    expect(domains).toContain("saints");
  });

  test("routes biographies with historical offices to history and saint sources", () => {
    const domains = routeRetrievalDomains("إزاي أريانوس الوالي تحول إلى مسيحي؟").domains;
    expect(domains).toContain("tari5");
    expect(domains).toContain("saints");
  });

  test("routes person epithet lookups to history and saint sources", () => {
    const domains = routeRetrievalDomains("مين هو قيثارة الروح و ليه اتسمى كده؟").domains;
    expect(domains).toContain("tari5");
    expect(domains).toContain("saints");
  });

  test("routes liturgical authorship to historical people before ritual instructions", () => {
    const domains = routeRetrievalDomains("مين واضع القداس الكيرلسي؟").domains;
    expect(domains).toContain("tari5");
    expect(domains).toContain("saints");
    expect(domains).not.toContain("taqs");

    expect(routeRetrievalDomains("إيه ترتيب القداس الكيرلسي؟").domains).toContain("taqs");
  });

  test("routes Coptic pope and heresy title questions to tari5", () => {
    expect(
      routeRetrievalDomains("ما دور البابا أثناسيوس الرسولي في مواجهه الأريوسيه؟").domains,
    ).toContain("tari5");
    expect(routeRetrievalDomains("ماذا نعرف عن البابا كيرلس عمود الدين؟").domains).toContain(
      "tari5",
    );
  });

  test("routes Orthodox title lookup questions to tari5", () => {
    expect(routeRetrievalDomains("من هو مصباح الأرثوذكسية؟").domains).toContain("tari5");
    expect(routeRetrievalDomains("من هو بطل الأرثوذكسية؟").domains).toContain("tari5");
  });

  test("routes school help explicitly without treating generic lessons as About intent", () => {
    expect(routeRetrievalDomains("إيه كتب ومناهج مدرسة الشمامسة؟").domains).toContain("school");
    expect(routeRetrievalDomains("إيه درس النهاردة؟").scores.school).toBe(0);
    expect(routeRetrievalDomains("عايز منهج عن الصلاة").scores.school).toBe(0);
  });
  test("routes Coptic grammar questions to coptic", () => {
    expect(routeRetrievalDomains("قواعد قبطي للمبتدئين").domains).toContain("coptic");
  });

  test("keeps Coptic language lookup questions near the history corpus", () => {
    const domains = routeRetrievalDomains("مين من الباحثين الأوروبيين مهتم باللغة القبطية؟").domains;
    expect(domains).toContain("coptic");
    expect(domains).toContain("tari5");
  });

  test("routes deacon rank questions to taqs", () => {
    expect(routeRetrievalDomains("إيه دور الابسالتس في الكنيسة؟").domains).toContain("taqs");
    expect(routeRetrievalDomains("رتب الشمامسة ابصالتس اغنسطس ذياكون").domains).toContain(
      "taqs",
    );
  });
  test("keeps broad feast questions multi-domain", () => {
    const domains = routeRetrievalDomains("عيد الميلاد والتجسد").domains;
    expect(domains).toContain("taqs");
    expect(domains).toContain("bible");
    expect(domains).toContain("ta3lim");
  });

  test("keeps ritual interpretation questions in teaching and ritual domains", () => {
    const domains = routeRetrievalDomains("ما ترتيب آحاد الصوم الكبير ومعنى كل أحد؟").domains;
    expect(domains).toContain("taqs");
    expect(domains).toContain("ta3lim");
  });

  test("does not route bare fasting Bible questions as ritual questions", () => {
    const domains = routeRetrievalDomains("ما معنى الصوم في الكتاب المقدس؟").domains;
    expect(domains).toContain("bible");
    expect(domains).not.toContain("taqs");
  });

  test("keeps Bible application questions in teaching and Bible domains", () => {
    const domains = routeRetrievalDomains("ماذا نتعلم من المرأة الشونمية في سفر الملوك الثاني؟").domains;
    expect(domains).toContain("bible");
    expect(domains).toContain("ta3lim");
  });

  test("keeps eucharist questions in ritual and doctrine domains", () => {
    const domains = routeRetrievalDomains("ما معنى الإفخارستيا في مزمور 111 والقداس؟").domains;
    expect(domains).toContain("taqs");
    expect(domains).toContain("tari5");
  });

  test("routes Mass-part and sacramental ritual phrases to taqs", () => {
    expect(routeRetrievalDomains("كلمات الأنافورا من الكتاب المقدس").domains).toContain("taqs");
    expect(routeRetrievalDomains("مرجعية صلاة الصلح من الكتاب المقدس").domains).toContain("taqs");
    expect(routeRetrievalDomains("الإبروسفارين يرمز لإيه؟").domains).toContain("taqs");
    expect(routeRetrievalDomains("امتى بيحل الروح القدس في سر الزيجة؟").domains).toContain("taqs");
    expect(
      routeRetrievalDomains("فيه كام قربانة في الحمل؟ و العدد ده بيرمز لإيه؟").domains,
    ).toContain("taqs");
  });

  test("does not give bare marriage language a taqs route score without sacramental phrasing", () => {
    expect(routeRetrievalDomains("إيه نصائح الزواج؟").scores.taqs).toBe(0);
    expect(routeRetrievalDomains("إيه معنى الزيجة؟").scores.taqs).toBe(0);
  });

  test("does not let ambiguous service language exclude Bible-domain sources", () => {
    const route = routeRetrievalDomains(
      "إيه اللي حصل في أول سنة من خدمة السيد المسيح على الأرض؟",
    );

    expect(route.domains).toContain("ta3lim");
    expect(route.domains).toContain("bible");
  });
  test("routes saint commemoration vocabulary to saints", () => {
    expect(routeRetrievalDomains("امتى عيد استشهاد مارجرجس؟").domains).toContain("saints");
    expect(routeRetrievalDomains("متى كانت نياحة الأنبا أنطونيوس؟").domains).toContain("saints");
    expect(routeRetrievalDomains("تذكار انتقال القديسة دميانة").domains).toContain("saints");
  });
});
