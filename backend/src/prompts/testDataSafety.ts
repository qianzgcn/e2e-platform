const WRITE_INTENT_PATTERN =
  /创建|新建|新增|添加|保存|编辑|修改|更新|删除|移除|归档|禁用|启用|绑定|解绑|分配|上传|导入|发布|审批|审核|重置|变更.{0,6}状态|切换.{0,6}状态|\b(?:create|add|save|edit|update|delete|remove|archive|disable|enable|bind|assign|upload|import|publish|reset)\b/i;
const WRITE_COMMIT_PATTERN = /成功|保存|提交|确定|确认|完成|生效|\b(?:success|save|submit|confirm|complete)\b/i;
const DIRECT_MUTATION_PATTERN =
  /删除|移除|归档|禁用|启用|绑定|解绑|分配|上传|导入|发布|审批|审核|重置|变更.{0,6}状态|切换.{0,6}状态|\b(?:delete|remove|archive|disable|enable|bind|assign|upload|import|publish|reset)\b/i;
const ISOLATED_DATA_PATTERN =
  /(?:运行时|本次运行|本次用例).{0,12}(?:唯一|随机|临时)|(?:唯一|随机).{0,8}(?:临时|测试)(?:数据|名称|标识|记录)?|UUID|时间戳|unique temporary|runtime unique|random test/i;
const OWNED_DATA_PATTERN =
  /(?:只|仅).{0,12}(?:操作|修改|编辑|删除|变更|清理).{0,20}(?:本次|临时|该临时)|(?:操作|修改|编辑|删除|变更).{0,16}(?:本次创建|本次生成|临时对象|临时数据)|only.{0,20}(?:temporary|created by this test)/i;
const CLEANUP_PATTERN =
  /finally|无论.{0,20}(?:成功|失败|异常)|(?:清理|删除|移除).{0,20}(?:本次|临时|运行时)|恢复.{0,20}(?:原始|初始)状态|cleanup|clean up/i;

export type TestDataSafetyIssue = {
  problem: string;
  suggestion: string;
};

export function validateTestDataSafety(naturalLanguage: string): TestDataSafetyIssue | null {
  const hasPersistentMutation = DIRECT_MUTATION_PATTERN.test(naturalLanguage)
    || (WRITE_INTENT_PATTERN.test(naturalLanguage) && WRITE_COMMIT_PATTERN.test(naturalLanguage));
  if (!hasPersistentMutation) return null;

  const missing: string[] = [];
  if (!ISOLATED_DATA_PATTERN.test(naturalLanguage)) missing.push("运行时唯一的临时数据");
  if (!OWNED_DATA_PATTERN.test(naturalLanguage)) missing.push("只操作本次创建的数据");
  if (!CLEANUP_PATTERN.test(naturalLanguage)) missing.push("失败或异常时也会执行的清理步骤");
  if (!missing.length) return null;

  const referencesProjectVariables = /\$\{[^}]+\}/.test(naturalLanguage);
  return {
    problem: `用例包含会持久化修改业务数据的操作，但没有明确${missing.join("和")}。用例开始前已经存在的所有业务数据都禁止修改或删除。${referencesProjectVariables ? "项目变量同样属于受保护的共享数据，只能用于登录、查询、只读关联或断言。" : ""}`,
    suggestion: "新增场景应使用本次运行生成的唯一临时数据；编辑、删除或状态变更场景必须先创建临时对象，再只操作该对象，并使用 try/finally 清理本次创建的数据。",
  };
}

export function formatTestDataSafetyIssue(issue: TestDataSafetyIssue) {
  return `问题：${issue.problem}\n修改建议：${issue.suggestion}`;
}
