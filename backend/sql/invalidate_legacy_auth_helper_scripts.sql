-- 旧脚本依赖当前项目专属的全局登录 helper；清空后在下次运行时按项目配置重新生成。
UPDATE `TestCase`
SET `playwrightScript` = NULL,
    `scriptNeedsGeneration` = TRUE,
    `status` = 'not_run',
    `lastFailureReason` = NULL,
    `scriptGeneratedAt` = NULL
WHERE `playwrightScript` LIKE '%../utils/auth%';
