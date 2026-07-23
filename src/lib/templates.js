// Template inventory for automated client notifications (шаблонные рассылки).
// DB-free single source of truth for WHAT each template says and WHICH parts
// are auto vs manual; imported by the cabinet UI and the sender so preview ===
// what the client receives. Categories mirror mqa_chat_mailings.category
// (primary_docs/debts/salary/main_taxes) for 1:1 dedup. Assembly (req 1):
// 'auto' (data+period+language), 'manual' (accountant attaches a file first —
// salary ведомость / tax report PDF, req 2), 'mixed' (auto text + an amount).

export const MAILING_CATEGORIES = ['primary_docs', 'debts', 'salary', 'main_taxes']

export const CATEGORY_LABELS = {
  primary_docs: 'Первичка (запрос документов)',
  debts: 'Долги / оплата услуг',
  salary: 'Заработная плата',
  main_taxes: 'Налоги / отчёт',
}

// Department default schedule day-of-month (Правила отдела бухгалтерии). A
// company may override these in kk_mailing_schedule; this is only the seed.
export const CATEGORY_DEFAULT_DAY = {
  primary_docs: 28,
  debts: 5,
  salary: 10,
  main_taxes: 15,
}

// The three supported message languages. client_telegram_chats.language uses
// exactly these codes; mqa_chats.chat_name encodes the same as a suffix.
export const LANGUAGES = ['RU', 'AM', 'ENG']

// Map a stored language code to the template text key.
export const LANG_TEXT_KEY = { RU: 'ru', AM: 'hy', ENG: 'en' }

// A single mailing "kind": category + subtype. subtype lets one category carry
// more than one real template (e.g. salary "table" vs "no employees").
export const TEMPLATES = {
  primary_docs: {
    request: {
      category: 'primary_docs',
      subtype: 'request',
      label: 'Запрос первичной документации',
      assembly: 'auto',
      manualAsset: null,
      // {{month}} = reporting month name in the message language.
      text: {
        ru: `Уважаемые коллеги!
Для своевременного составления отчётности просим предоставить следующую информацию за {{month}}. Пожалуйста, направляйте только ту информацию, которая относится к вам; если уже предоставляли — повторно отправлять не нужно.

1. Информация по выставляемым счетам (инвойс, акт выполненных работ, счёт-фактура).
2. Документы по импорту/экспорту (договор, инвойс, CMR, декларация, товаросопроводительные документы, коды ТН ВЭД, вес товара) — по возможности сразу после получения.
3. Банковские выписки по всем счетам и валютам — с начала года по конец соответствующего месяца.
4. Данные для расчёта заработной платы.
5. Информация о наличии ВНЖ или Work Permit в 2026 году с указанием периода действия.

Заранее благодарим!`,
        hy: `Հարգելի գործընկերներ։
Հաշվետվությունների ժամանակին և ճշգրիտ կազմման համար խնդրում ենք տրամադրել հետևյալ տեղեկատվությունը՝ {{month}} ամսվա համար։ Խնդրում ենք ներկայացնել միայն Ձեզ վերաբերվող տեղեկատվությունը. եթե արդեն տրամադրել եք, կրկնակի ուղարկելու անհրաժեշտություն չկա։

1. Դուրս գրվող հաշիվների վերաբերյալ տեղեկատվություն (ինվոյս, ակտ, հաշիվ-ապրանքագիր)։
2. Ներմուծման/արտահանման փաստաթղթեր (պայմանագիր, ինվոյս, CMR, հայտարարագիր, ապրանքային փաստաթղթեր, ՏՀ ՎԵԴ կոդեր, քաշ)՝ հնարավորության դեպքում անմիջապես ստանալուց հետո։
3. Բանկային քաղվածքներ՝ բոլոր հաշիվներով և արժույթներով՝ տարվա սկզբից մինչև համապատասխան ամսվա ավարտը։
4. Աշխատավարձի հաշվարկի տվյալներ։
5. Տեղեկություն 2026թ․ ВНЖ կամ Work Permit-ի առկայության մասին՝ նշելով ժամանակահատվածը։

Կանխավ շնորհակալություն։`,
        en: `Dear colleagues,
To ensure the timely and accurate preparation of your reports, please provide the following information for {{month}}. Please send only the information relevant to your business; if you have already provided it, there is no need to resend.

1. Information on issued documents (invoices, acts of acceptance, tax invoices).
2. Import/export documents (contract, invoice, CMR, customs declaration, shipping documents, HS codes, cargo weight) — preferably immediately upon receipt.
3. Bank statements for all accounts and currencies — from the beginning of the year through the end of the relevant month.
4. Payroll calculation data.
5. Information on a Residence Permit (TRC) or Work Permit in 2026, including the validity period.

Thank you in advance!`,
      },
    },
  },

  debts: {
    service_payment: {
      category: 'debts',
      subtype: 'service_payment',
      label: 'Оплата услуг / налоговая оптимизация (до 5)',
      assembly: 'mixed', // {{amount}}/{{period}}/{{due_day}} pulled from data
      manualAsset: null,
      text: {
        ru: `ДЛЯ СДАЧИ ОТЧЁТНОСТИ И ПОЛУЧЕНИЯ НАЛОГОВОЙ ОПТИМИЗАЦИИ

Оплатите бухгалтерские услуги до {{due_day}} числа — мы учтём их в расходах текущего периода и снизим налоговую нагрузку.

Для соблюдения сроков и непрерывности работы просим оплатить услуги до {{due_day}} числа (за {{period}}). Отчётность сдаётся только после оплаты услуг.

Реквизиты:
• р/с: 1930097970708600 (AMD)
• банк: Converse Bank
• получатель: Business Tech LLC
• ИНН: 02909907
• назначение: payment for accountant service (ИНН)
• сумма: {{amount}}
• период: {{period}}

После оплаты продолжаем работу в полном объёме.
Спасибо!`,
        hy: `ՀԱՇՎԵՏՎՈՒԹՅԱՆ ՀԱՆՁՆՄԱՆ ԵՎ ՀԱՐԿԵՐՆ ՕՊՏԻՄԱԼԱՑՆԵԼՈՒ ՀԱՄԱՐ

Կատարեք հաշվապահական ծառայությունների վճարումը մինչև ամսի {{due_day}}-ը, որպեսզի այն ներառենք ընթացիկ ժամանակահատվածի ծախսերում և նվազեցնենք հարկային բեռը։

Ժամկետների պահպանման համար խնդրում ենք վճարումը կատարել մինչև ամսի {{due_day}}-ը ({{period}} համար)։ Հաշվետվությունը ներկայացվում է միայն վճարումից հետո։

Վճարման տվյալներ՝
• հ/հ՝ 1930097970708600 (AMD)
• բանկ՝ Converse Bank
• ստացող՝ Business Tech LLC
• ՀՎՀՀ՝ 02909907
• նշանակություն՝ payment for accountant service (ՀՎՀՀ)
• գումար՝ {{amount}}
• ժամանակահատված՝ {{period}}

Վճարումից հետո շարունակում ենք աշխատանքը ամբողջ ծավալով։
Շնորհակալություն։`,
        en: `FOR REPORT SUBMISSION AND TAX OPTIMIZATION

Please pay for accounting services by the {{due_day}}th of the month — we will include them in the current period's expenses and reduce the tax burden.

To meet deadlines and ensure continuity of work, please make the payment by the {{due_day}}th (for {{period}}). Reports are submitted only after payment is received.

Bank details:
• Account number: 1930097970708600 (AMD)
• Bank: Converse Bank
• Beneficiary: Business Tech LLC
• TIN: 02909907
• Payment purpose: payment for accountant service (TIN)
• Amount: {{amount}}
• Period: {{period}}

After payment, we continue working in full.
Thank you!`,
      },
    },
    reminder: {
      category: 'debts',
      subtype: 'reminder',
      label: 'Напоминание об оплате (долг)',
      assembly: 'mixed',
      manualAsset: null,
      text: {
        ru: `Напоминаем о необходимости произвести оплату для продолжения работы.
Реквизиты:
• р/с: 1930097970708600 (AMD)
• банк: Converse Bank
• получатель: Business Tech LLC
• ИНН: 02909907
• назначение: payment for accountant service
• сумма: {{amount}}
• период: {{period}}

После оплаты продолжаем работу в полном объёме. Спасибо!`,
        hy: `Հիշեցնում ենք վճարումը կատարելու անհրաժեշտության մասին՝ աշխատանքը շարունակելու համար։
Վճարման տվյալներ՝
• հ/հ՝ 1930097970708600 (AMD)
• բանկ՝ Converse Bank
• ստացող՝ Business Tech LLC
• ՀՎՀՀ՝ 02909907
• նշանակություն՝ payment for accountant service
• գումար՝ {{amount}}
• ժամանակահատված՝ {{period}}

Վճարումից հետո շարունակում ենք աշխատանքը ամբողջ ծավալով։ Շնորհակալություն։`,
        en: `We kindly remind you of the need to make a payment in order to continue services.
Bank details:
• Account number: 1930097970708600 (AMD)
• Bank: Converse Bank
• Beneficiary: Business Tech LLC
• TIN: 02909907
• Payment purpose: payment for accounting services
• Amount: {{amount}}
• Period: {{period}}

After payment, we continue working in full. Thank you!`,
      },
    },
  },

  salary: {
    table: {
      category: 'salary',
      subtype: 'table',
      label: 'Ведомость по зарплате (до 10)',
      assembly: 'manual', // requires the salary sheet file (req 2)
      manualAsset: 'salary_sheet',
      text: {
        ru: `Добрый день!
Направляю таблицу по заработным платам, также сообщаю, что оплаты проставлены в банке.`,
        hy: `Բարի օր։
Ուղարկում եմ աշխատավարձերի աղյուսակը, ինչպես նաև տեղեկացնում եմ, որ վճարումները նշվել են բանկում։`,
        en: `Good day,
I am sending the salary table and would also like to inform you that the payments have been entered in the bank system.`,
      },
    },
    no_employees: {
      category: 'salary',
      subtype: 'no_employees',
      label: 'Нет сотрудников (зарплата не начисляется)',
      assembly: 'auto',
      manualAsset: null,
      text: {
        ru: `Сообщаем, что начисление заработной платы за текущий период не производится в связи с отсутствием сотрудников в компании. В случае появления сотрудников или планирования приёма на работу просим заранее уведомить бухгалтерию. Благодарим!`,
        hy: `Տեղեկացնում ենք, որ ընթացիկ ժամանակահատվածի համար աշխատավարձի հաշվարկ չի կատարվում՝ ընկերությունում աշխատակիցների բացակայության պատճառով։ Աշխատակիցներ ընդունելու դեպքում խնդրում ենք նախապես տեղեկացնել հաշվապահությանը։ Շնորհակալություն։`,
        en: `We would like to inform you that no salary calculation is being carried out for the current period due to the absence of employees. If hiring is planned, please inform the accounting department in advance. Thank you.`,
      },
    },
  },

  main_taxes: {
    // «Уведомление о платежах» — the tax table (VAT/income/social/stamp/
    // insurance/turnover/profit/excise/salary/accounting) with fixed treasury
    // accounts; the amounts come from the tax расчёт (armsoft/taxservice) and
    // accompany the manual tax report, so it is grouped as a tax_report asset.
    payment_notice: {
      category: 'main_taxes',
      subtype: 'payment_notice',
      label: 'Уведомление о платежах (таблица налогов)',
      assembly: 'manual',
      manualAsset: 'tax_report',
      text: {
        ru: `УВЕДОМЛЕНИЕ О ПЛАТЕЖАХ. Отчётный период: {{period}}.
По результатам расчёта подлежат уплате (AMD):
• НДС / Подоходный / Соц. оплата / Налог с оборота / Налог на прибыль (аванс) / Налог нерезидента / Акциз — р/с 900008000490
• Гербовый сбор — р/с 900005001186
• Страховой взнос — р/с 900005003703
• Заработная плата; Бухгалтерские услуги — р/с 1930097970708600
Суммы и сроки — по расчёту. При нарушении срока пеня 0,075% за день (ст. 401 НК РА). Уведомление носит информационный характер.`,
        hy: `ՎՃԱՐՄԱՆ ԵՆԹԱԿԱ ՊԱՐՏԱՎՈՐՈՒԹՅՈՒՆՆԵՐԻ ՄԱՍԻՆ ԾԱՆՈՒՑՈՒՄ։ Հաշվետու ժամանակաշրջան՝ {{period}}։
Հաշվարկի արդյունքներով վճարման ենթակա են (AMD)՝
• ԱԱՀ / Եկամտային / Սոցիալական / Շրջանառության / Շահութահարկ (կանխավճար) / Ոչ ռեզիդենտի / Ակցիզ — հ/հ 900008000490
• Դրոշմանիշային վճար — հ/հ 900005001186
• Ապահովագրավճար — հ/հ 900005003703
• Աշխատավարձ; Հաշվապահական ծառայություններ — հ/հ 1930097970708600
Գումարներն ու ժամկետները՝ ըստ հաշվարկի։ Ժամկետը խախտելու դեպքում տույժ՝ օրական 0,075% (ՀՀ ՀՕ 401 հոդված)։ Ծանուցումը կրում է տեղեկատվական բնույթ։`,
        en: `PAYMENT NOTIFICATION. Reporting period: {{period}}.
Per the calculation, the following are payable (AMD):
• VAT / Income / Social / Turnover / Profit (advance) / Non-resident profit / Excise — acct 900008000490
• Stamp duty — acct 900005001186
• Insurance contribution — acct 900005003703
• Salary; Accounting services — acct 1930097970708600
Amounts and deadlines per the calculation. Late payment penalty 0.075%/day (Art. 401, RA Tax Code). This notification is informational.`,
      },
    },
    report: {
      category: 'main_taxes',
      subtype: 'report',
      label: 'Отчёт сдан + расчёт налогов (до 15)',
      assembly: 'manual', // requires the tax report PDF / расчёт file (req 1/2)
      manualAsset: 'tax_report',
      text: {
        ru: `Добрый день!
Отчёт подготовлен и сдан. Следующим сообщением направляю PDF отчёта, а также расчёт налогов. Налоги выставлены в банке, прошу зайти и подтвердить оплаты.`,
        hy: `Բարի օր։
Հաշվետվությունը պատրաստ է և ներկայացված։ Հաջորդ հաղորդագրությամբ կուղարկեմ հաշվետվության PDF տարբերակը, ինչպես նաև հարկերի հաշվարկը։ Հարկերը նշված են բանկում, խնդրում եմ մուտք գործել և հաստատել վճարումները։`,
        en: `Good day,
The report has been prepared and submitted. In my next message I will send the PDF of the report and the tax calculation. The taxes are available in the bank system; please log in and approve the payments.`,
      },
    },
  },
}

// Flatten TEMPLATES into a lookup keyed "category:subtype" and a list.
export const TEMPLATE_LIST = Object.values(TEMPLATES).flatMap((subs) => Object.values(subs))

export function templateKey(category, subtype) {
  return `${category}:${subtype}`
}

export function getTemplate(category, subtype) {
  return TEMPLATES[category]?.[subtype] ?? null
}

// Does a category require a manual file/marker before the bot can send it?
// (salary ведомость, tax report). Used to build the manual-add sections (req 2)
// and to block a planned mailing whose file is missing.
export function manualAssetForCategory(category) {
  const subs = TEMPLATES[category]
  if (!subs) return null
  for (const t of Object.values(subs)) if (t.manualAsset) return t.manualAsset
  return null
}

export const MANUAL_ASSET_KINDS = ['salary_sheet', 'tax_report']

export const MANUAL_ASSET_LABELS = {
  salary_sheet: 'Ведомость по заработной плате',
  tax_report: 'Отчёт / расчёт налогов (PDF)',
}
