import type { ProjectVariable } from "./testCaseRunTypes.js";

// 变量替换只用于 AI 动态输入，不修改自然语言用例原文。
export function resolveTestCaseVariables(naturalLanguage: string, variables: ProjectVariable[]) {
  const variableMap = new Map(variables.map((variable) => [variable.name, variable.value]));

  return naturalLanguage.replace(/\$\{([^}]+)\}/g, (_match, variableName: string) => {
    const name = variableName.trim();
    const value = variableMap.get(name);

    if (value === undefined) {
      throw new Error(`变量 ${name} 未配置。请在项目设置中配置该变量，或修改用例中的 \${${name}} 占位符`);
    }

    return value;
  });
}
