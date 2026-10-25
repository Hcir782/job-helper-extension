/**
 * field-dictionary.js —— 字段别名词典
 *
 * 中文招聘网站的字段名千奇百怪：同一个"手机号"可能写成
 * 手机号码 / 联系电话 / 联系方式 / 移动电话 / 电话号码……
 * 这里为每个简历字段准备一份别名表，匹配时命中别名越长得分越高。
 *
 * 字段集合来源（阶段 3.5）：把两个真实校招申请表的字段做并集去重
 *   - 华勤技术（Moka ATS）：app.mokahr.com/campus-recruitment/hq/*
 *   - 快手校招：campus.kuaishou.cn/recruit/campus/e/
 * 重复项合并（如"现居住地 / 现在居住城市"→ address，
 * "意向工作城市 / 意向地点"→ expectCity，"自我描述 / 自我评价"→ selfIntro），
 * 列表型经历（教育/实习/项目/获奖/在校职务/证书/论文作品）用整段文本框承载。
 *
 * ⚠️ 版权说明：别名表的整理思路参考了开源项目 OpenJobAutofill
 *    （MIT License, Copyright (c) 2026 Br1an67）。
 */

const JH_FIELD_KEYWORDS = {
  // ===== 基本信息（13）=====
  name: [
    "姓名", "真实姓名", "中文姓名", "申请人姓名", "姓　　名", "姓名（中文）",
    "名字", "name", "fullname", "full name", "realname",
  ],
  gender: ["性别", "gender", "sex"],
  birth: [
    "出生年月", "出生日期", "出生时间", "出生年月日", "生日", "出生",
    "birthday", "birth", "dateofbirth",
  ],
  phone: [
    "手机号码", "手机号", "手机", "联系电话", "联系方式", "电话号码", "移动电话",
    "本人电话", "联系手机", "phone", "mobile", "telephone", "tel",
  ],
  email: [
    "电子邮箱", "邮箱地址", "邮箱", "电子邮件", "邮件地址", "常用邮箱", "联系邮箱",
    "email", "e-mail", "mail",
  ],
  idType: ["证件类型", "证件类别", "身份证件类型", "证件种类", "idtype"],
  idCard: [
    "证件号码", "证件号", "身份证号码", "身份证号", "身份证件号码", "身份证",
    "idcard", "idno", "idnumber",
  ],
  nationality: ["国籍", "国家/地区", "国籍（地区）", "nationality"],
  nation: ["民族", "民族（如汉族）", "nation", "ethnicity"],
  politics: ["政治面貌", "政治身份", "党派", "politicalstatus"],
  address: [
    "现居住地", "现在居住城市", "现居住城市", "居住城市", "现居地", "现住址",
    "居住地", "通讯地址", "联系地址", "详细地址", "所在城市", "所在地区",
    "address", "currentcity", "location",
  ],
  emergencyContact: ["紧急联系人", "紧急联系人姓名", "紧急联络人", "联系人姓名"],
  emergencyPhone: ["紧急联系人电话", "紧急联系人手机", "紧急联系电话", "紧急联络电话"],

  // ===== 教育背景（7）=====
  education: [
    "最高学历", "学历层次", "学历学位", "学历/学位", "最高学位", "学历",
    "education", "degree",
  ],
  graduationYear: [
    "毕业年份", "毕业时间", "毕业年度", "毕业日期", "最高学历毕业日期",
    "取得毕业证时间", "预计毕业时间", "graduationyear", "graduation",
  ],
  school: [
    "毕业院校", "毕业学校", "学校名称", "院校名称", "最高学历学校", "最高学历院校",
    "学校", "院校", "就读学校", "school", "university",
  ],
  college: [
    "学院名称", "所在学院", "院系名称", "二级学院", "学院", "院系", "系别",
    "college", "faculty", "department",
  ],
  major: [
    "最高学历专业", "所学专业", "专业名称", "专业方向", "学科专业", "专业",
    "major", "specialty",
  ],
  studyMode: ["学习形式", "学习方式", "培养方式", "就读形式", "教育形式"],
  gpaRank: [
    "成绩排名", "专业排名", "年级排名", "班级排名", "排名", "绩点", "GPA",
    "平均绩点", "加权平均分", "平均分", "学分绩点",
  ],
  isOverseas: [
    "是否境外留学", "是否为中国境外留学经历", "境外留学经历", "海外留学经历",
    "是否留学", "留学经历",
  ],
  eduDetail: [
    "教育经历", "教育背景明细", "教育经历明细", "学习经历", "教育与培训经历",
    "educationexperience",
  ],
  highSchool: ["高中经历", "高中学校", "高中名称", "毕业高中", "高中信息"],

  // ===== 求职意向（7）=====
  workYears: [
    "工作年限", "工作经验年限", "工作经验", "从业年限", "工作年限（年）",
    "workyears", "workyear", "experience",
  ],
  expectPosition: [
    "期望职位", "意向职位", "期望岗位", "意向岗位", "应聘岗位", "申请岗位", "目标岗位",
    "期望工作", "求职意向", "expectposition", "desiredposition",
  ],
  expectCity: [
    "期望城市", "意向城市", "期望工作城市", "期望工作地点", "期望地点", "意向地点",
    "意向工作城市", "工作城市", "意向城市（可多选）", "期望城市（可多选）",
    "expectcity", "expectedcity",
  ],
  expectSalary: [
    "期望薪资", "期望月薪", "期望年薪", "期待薪资", "期望年收入", "薪资要求", "期望工资",
    "salary", "expectedsalary",
  ],
  acceptRelocate: [
    "是否接受调剂", "是否接受工作城市调剂", "是否可接受工作城市调剂",
    "是否服从调剂", "服从调剂", "接受调剂", "是否接受城市调剂",
  ],
  availableIntern: ["是否可实习", "是否可参加实习", "可实习", "是否接受实习"],
  sourceChannel: [
    "了解渠道", "最初从何处了解", "从何处了解到", "招聘信息来源", "招聘渠道",
    "获知渠道", "了解途径", "信息来源", "职位信息来源",
  ],
  referrerCode: ["推荐码", "内推码", "内推邀请码", "外推码", "推荐人", "邀请码", "referralcode"],

  // ===== 经历与能力（9）=====
  internshipExp: [
    "实习经历", "实习经验", "实习情况", "实习内容", "实习工作经历", "实习与工作经历",
    "internship", "internshipexperience",
  ],
  projectExp: [
    "项目经历", "项目经验", "项目描述", "项目名称", "主要项目", "项目介绍",
    "project", "projectexperience",
  ],
  campusExp: [
    "在校职务", "校内职务", "在校经历", "学生干部经历", "社团经历", "在校职务名称",
    "校园经历",
  ],
  awards: [
    "获奖经历", "获奖情况", "奖项名称", "竞赛获奖", "获奖名称", "所获奖励", "荣誉",
    "其他荣誉", "获奖",
  ],
  certificates: [
    "技能证书", "证书名称", "资格证书", "职业资格", "证书种类", "证书",
    "技能证书名称",
  ],
  languageLevel: [
    "语言能力", "语言等级", "最高语言等级考试", "外语水平", "英语等级",
    "语言水平", "外语能力",
  ],
  skills: ["技能", "专业技能", "技能特长", "掌握技能", "技术栈", "个人技能"],
  papers: ["论文", "论文名称", "论文链接", "发表论文", "学术成果", "专利"],
  portfolio: ["作品", "作品链接", "作品信息", "作品集", "个人作品", "作品名称"],

  // ===== 工作与补充（4）=====
  currentCompany: [
    "当前公司", "所在公司", "公司名称", "工作单位", "单位名称", "现任公司", "目前公司",
    "company", "currentcompany", "employer",
  ],
  currentPosition: [
    "当前职位", "现任职位", "当前职务", "职位名称", "职务名称", "岗位名称", "目前职位",
    "currentposition", "jobtitle",
  ],
  selfIntro: [
    "自我评价", "自我介绍", "个人简介", "个人优势", "个人描述", "自我描述", "个人总结",
    "个人亮点", "自我认知", "intro", "summary", "aboutme",
  ],
  hobbies: ["兴趣爱好", "爱好", "特长", "个人爱好", "兴趣", "hobbies", "interests"],
};

/** 字段分组（面板渲染与文档共用） */
const JH_FIELD_GROUPS = [
  {
    title: "基本信息",
    fields: [
      "name", "gender", "birth", "phone", "email",
      "idType", "idCard", "nationality", "nation", "politics",
      "address", "emergencyContact", "emergencyPhone",
    ],
  },
  {
    title: "教育背景",
    fields: [
      "education", "graduationYear", "school", "college", "major",
      "studyMode", "gpaRank", "isOverseas", "eduDetail", "highSchool",
    ],
  },
  {
    title: "求职意向",
    fields: [
      "expectPosition", "expectCity", "expectSalary", "workYears",
      "acceptRelocate", "availableIntern", "sourceChannel", "referrerCode",
    ],
  },
  {
    title: "经历与能力",
    fields: [
      "internshipExp", "projectExp", "campusExp", "awards",
      "certificates", "languageLevel", "portfolio", "skills", "papers",
    ],
  },
  {
    title: "工作与补充",
    fields: ["currentCompany", "currentPosition", "selfIntro", "hobbies"],
  },
];

/** 同时挂到 window，便于调试与其他脚本访问 */
window.JH_FIELD_KEYWORDS = JH_FIELD_KEYWORDS;
window.JH_FIELD_GROUPS = JH_FIELD_GROUPS;
