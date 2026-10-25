/**
 * field-dictionary.js —— 字段别名词典
 *
 * 中文招聘网站的字段名千奇百怪：同一个"手机号"可能写成
 * 手机号码 / 联系电话 / 联系方式 / 移动电话 / 电话号码……
 * 这里为每个简历字段准备一份别名表，匹配时命中别名越长得分越高。
 *
 * ⚠️ 版权说明：别名表的整理思路参考了开源项目 OpenJobAutofill
 *    （MIT License, Copyright (c) 2026 Br1an67），
 *    本项目按其字段覆盖思路裁剪、改写为本插件使用的 17 个字段。
 */

const JH_FIELD_KEYWORDS = {
  // ===== 基本信息 =====
  name: [
    "姓名", "真实姓名", "中文姓名", "申请人姓名", "姓　　名", "姓名（中文）",
    "名字", "name", "fullname", "full name", "realname",
  ],
  gender: ["性别", "gender", "sex"],
  phone: [
    "手机号码", "手机号", "手机", "联系电话", "联系方式", "电话号码", "移动电话",
    "本人电话", "联系手机", "phone", "mobile", "telephone", "tel",
  ],
  birth: [
    "出生年月", "出生日期", "出生时间", "出生年月日", "生日", "出生",
    "birthday", "birth", "dateofbirth",
  ],
  email: [
    "电子邮箱", "邮箱地址", "邮箱", "电子邮件", "邮件地址", "常用邮箱", "联系邮箱",
    "email", "e-mail", "mail",
  ],

  // ===== 教育背景 =====
  education: ["最高学历", "学历层次", "学历学位", "学历/学位", "最高学位", "学历", "education", "degree"],
  graduationYear: [
    "毕业年份", "毕业时间", "毕业年度", "毕业日期", "取得毕业证时间", "预计毕业时间",
    "graduationyear", "graduation",
  ],
  school: [
    "毕业院校", "毕业学校", "学校名称", "院校名称", "最高学历院校", "学校", "院校",
    "就读学校", "school", "university", "college",
  ],
  major: ["所学专业", "专业名称", "专业方向", "学科专业", "专业", "major", "specialty"],

  // ===== 求职意向 / 工作 =====
  workYears: [
    "工作年限", "工作经验年限", "工作经验", "从业年限", "工作年限（年）",
    "workyears", "workyear", "experience",
  ],
  expectSalary: [
    "期望薪资", "期望月薪", "期望年薪", "期待薪资", "期望年收入", "薪资要求", "期望工资",
    "salary", "expectedsalary",
  ],
  currentCompany: [
    "当前公司", "所在公司", "公司名称", "工作单位", "单位名称", "现任公司", "目前公司",
    "company", "currentcompany", "employer",
  ],
  currentPosition: [
    "当前职位", "现任职位", "当前职务", "职位名称", "职务名称", "岗位名称", "目前职位",
    "currentposition", "jobtitle",
  ],
  expectPosition: [
    "期望职位", "意向职位", "期望岗位", "意向岗位", "应聘岗位", "申请岗位", "目标岗位",
    "期望工作", "求职意向", "expectposition", "desiredposition",
  ],
  expectCity: [
    "期望城市", "意向城市", "期望工作城市", "期望工作地点", "期望地点", "意向地点",
    "工作城市", "期望城市（可多选）", "expectcity", "expectedcity",
  ],

  // ===== 补充信息 =====
  selfIntro: [
    "自我评价", "自我介绍", "个人简介", "个人优势", "个人描述", "自我描述", "个人总结",
    "个人亮点", "intro", "summary", "aboutme",
  ],
  projectExp: [
    "项目经历", "项目经验", "项目描述", "项目名称", "主要项目", "项目介绍",
    "project", "projectexperience",
  ],
};

/** 同时挂到 window，便于调试与其他脚本访问 */
window.JH_FIELD_KEYWORDS = JH_FIELD_KEYWORDS;
