-- 旧版生成流程会把不可执行原因写成主动抛错的 spec；将这类产物一次性失效，让下次运行进入新的用例有效性检查。
UPDATE `TestCase`
SET
  `playwrightScript` = NULL,
  `scriptGeneratedAt` = NULL,
  `scriptNeedsGeneration` = TRUE,
  `status` = 'not_run',
  `lastRunAt` = NULL,
  `lastFailureReason` = NULL
WHERE `playwrightScript` IS NOT NULL
  AND `playwrightScript` LIKE '%throw new Error(%'
  AND `playwrightScript` LIKE '%用例不可执行：%';
