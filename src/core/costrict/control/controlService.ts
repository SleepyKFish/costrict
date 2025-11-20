import * as vscode from "vscode"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import type { ClineProvider } from "../../webview/ClineProvider"
import {
	type ControlTaskConfig,
	type ControlTaskProgress,
	type SubTask,
	ControlTaskStatus,
	SubTaskStatus,
	type ExtractedPathInfo,
} from "./types"
import { extractDirectoryFromPrompt, getFilteredFiles, validateDirectory } from "./fileParser"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { parseRules, extractFileListFromResponse } from "./ruleParser"

/**
 * Control 服务类 - 负责管理循环处理文件的整个流程
 */
export class ControlService {
	private static instance: ControlService | undefined
	private provider: ClineProvider | undefined
	private currentTask: ControlTaskConfig | undefined
	private currentProgress: ControlTaskProgress | undefined
	private isProcessing: boolean = false
	private currentSubTaskIndex: number = -1
	private shouldCancel: boolean = false

	private constructor() {}

	public static getInstance(): ControlService {
		if (!ControlService.instance) {
			ControlService.instance = new ControlService()
		}
		return ControlService.instance
	}

	/**
	 * 设置 Provider
	 */
	public setProvider(provider: ClineProvider): void {
		this.provider = provider
	}

	/**
	 * 开始 Loop 任务
	 * @param userPrompt 用户输入的提示词
	 */
	public async startControlTask(userPrompt: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		if (this.isProcessing) {
			vscode.window.showWarningMessage("已有任务正在处理中,请稍后再试")
			return
		}

		try {
			this.isProcessing = true
			this.shouldCancel = false

			// 0. 解析规则
			const rules = parseRules(userPrompt)

			if (rules.isRuleMode) {
				// 规则模式：先发现文件，再处理
				await this.startRuleModeTask(rules.discoveryRule!, rules.processingRule!)
			} else {
				// 传统模式：保持原有流程
				await this.startTraditionalModeTask(rules.originalPrompt!)
			}
		} catch (error) {
			this.provider?.log(`[Control] Error: ${error}`)
			const completedCount =
				this.currentTask?.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length || 0
			const failedCount = this.currentTask?.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length || 0

			this.sendProgressUpdate({
				status: ControlTaskStatus.FAILED,
				currentFileIndex: this.currentSubTaskIndex + 1,
				totalFiles: this.currentTask?.files.length || 0,
				completedCount,
				failedCount,
				message: `任务失败: ${error instanceof Error ? error.message : String(error)}`,
			})

			this.provider?.log("[Control] Task failed, switching back to Loop view")

			// 清理状态
			this.cleanup()

			// 等待一小段时间确保进度更新消息被处理
			await new Promise((resolve) => setTimeout(resolve, 100))

			// 任务失败后，自动切换回 Loop 界面
			await this.provider?.postMessageToWebview({
				type: "action",
				action: "controlButtonClicked",
			})
		}
	}

	/**
	 * 规则模式任务：先通过 AI 发现文件，再批量处理
	 */
	private async startRuleModeTask(discoveryRule: string, processingRule: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		// 1. 创建文件发现子任务记录
		const discoverySubTask: SubTask = {
			id: uuidv4(),
			filePath: "[文件发现任务]",
			status: SubTaskStatus.RUNNING,
			enabled: true,
			startTime: Date.now(),
		}

		// 初始化任务配置（先创建以便能展示文件发现子任务）
		this.currentTask = {
			userPrompt: processingRule,
			targetDirectory: "",
			files: [],
			subTasks: [discoverySubTask],
			discoveryRule,
			processingRule,
			isRuleMode: true,
		}

		this.sendProgressUpdate({
			status: ControlTaskStatus.DISCOVERING_FILES,
			currentFileIndex: 0,
			totalFiles: 1, // 包含文件发现任务
			completedCount: 0,
			failedCount: 0,
			message: "正在创建文件发现任务...",
		})

		const cwd = this.provider.cwd.toPosix()

		// 构建文件发现提示词
		const discoveryPrompt = `你的任务是根据以下规则，找出项目中需要处理的文件列表。

文件发现规则：${discoveryRule}

项目根目录：${cwd}

请分析项目结构，找出所有符合规则的文件。最后，请以 JSON 数组格式返回文件路径列表（相对于项目根目录）。

示例输出格式：
\`\`\`json
[
  "src/components/Button.tsx",
  "src/components/Input.tsx",
  "src/utils/helpers.ts"
]
\`\`\`

重要：
1. 请确保文件路径是相对于项目根目录的
2. 只返回实际存在的文件
3. 最终必须返回一个 JSON 数组格式的文件列表`

		this.provider.log(`[Control] Discovery prompt: ${discoveryPrompt}`)

		// 保存 discoveryTask 引用，用于后续获取响应
		let discoveryTask: any
		let validFiles: string[] = []

		try {
			// 创建文件发现任务
			discoveryTask = await this.provider.createTask(discoveryPrompt, [])

			// 保存任务 ID
			discoverySubTask.taskId = discoveryTask.taskId

			// 更新进度，同步 taskId 到 UI
			this.sendProgressUpdate({
				status: ControlTaskStatus.DISCOVERING_FILES,
				currentFileIndex: 0,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 0,
				message: "正在分析项目结构，发现文件...",
			})

			// 切换到对话界面，让用户可以与AI交互
			this.provider.log("[Control] Starting discovery task, switching to chat view")
			await this.provider.postMessageToWebview({
				type: "action",
				action: "hideControlView",
			})
			await new Promise((resolve) => setTimeout(resolve, 100))

			// 自动跳转到该对话任务
			await this.provider.showTaskWithId(discoveryTask.taskId)

			// 等待任务完成
			await this.waitForTaskCompletion(discoveryTask)

			// 2. 从任务结果中提取文件列表
			this.sendProgressUpdate({
				status: ControlTaskStatus.PARSING,
				currentFileIndex: 1,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 0,
				message: "正在解析文件列表...",
			})

			// 获取任务的最终响应（使用保存的 discoveryTask 引用）
			const taskResponse = this.getTaskResponse(discoveryTask)
			this.provider.log(`[Control] Discovery task response: ${taskResponse}`)

			// 解析文件列表
			this.provider.log(`[Control] Step 2: Parsing file list from response`)
			const files = extractFileListFromResponse(taskResponse)

			if (files.length === 0) {
				throw new Error("未能从文件发现任务中提取到有效的文件列表。请确保任务返回了 JSON 格式的文件数组。")
			}

			this.provider.log(`[Control] Extracted ${files.length} files from discovery task`)

			// 3. 验证文件是否存在
			this.provider.log(`[Control] Step 3: Validating ${files.length} files`)
			for (const file of files) {
				const filePath = file.startsWith("/") ? file.substring(1) : file
				try {
					const fullPath = path.join(this.provider.cwd, filePath)
					const uri = vscode.Uri.file(fullPath)
					await vscode.workspace.fs.stat(uri)
					validFiles.push(filePath)
				} catch (error) {
					this.provider.log(`[Control] File not found or inaccessible: ${filePath}`)
				}
			}

			if (validFiles.length === 0) {
				throw new Error("未找到有效文件")
			}

			// 解析成功，标记文件发现任务完成
			discoverySubTask.status = SubTaskStatus.COMPLETED
			discoverySubTask.endTime = Date.now()
			this.provider.log(
				`[Control] Discovery task completed successfully in ${((discoverySubTask.endTime - discoverySubTask.startTime!) / 1000).toFixed(2)}s`,
			)
		} catch (error) {
			discoverySubTask.status = SubTaskStatus.FAILED
			discoverySubTask.endTime = Date.now()
			discoverySubTask.error = error instanceof Error ? error.message : String(error)
			this.provider.log(`[Control] Discovery task failed: ${discoverySubTask.error}`)

			// 发送失败状态更新
			this.sendProgressUpdate({
				status: ControlTaskStatus.FAILED,
				currentFileIndex: 1,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 1,
				message: `文件发现任务失败: ${discoverySubTask.error}`,
			})

			// 切换回 Loop 界面显示错误
			await new Promise((resolve) => setTimeout(resolve, 100))
			await this.provider.postMessageToWebview({
				type: "action",
				action: "controlButtonClicked",
			})
			return
		}

		this.provider.log(`[Control] Validated ${validFiles.length} files`)

		// 4. 创建处理文件的子任务列表
		this.provider.log(`[Control] Step 4: Creating processing subtasks for ${validFiles.length} files`)
		const processingSubTasks: SubTask[] = validFiles.map((filePath) => ({
			id: uuidv4(),
			filePath,
			status: SubTaskStatus.PENDING,
			enabled: true, // 默认启用所有任务
		}))

		// 5. 更新任务配置（保留文件发现子任务）
		this.provider.log(`[Control] Step 5: Updating task configuration`)
		this.currentTask.files = validFiles
		this.currentTask.subTasks = [discoverySubTask, ...processingSubTasks]

		// 发送进度更新，显示所有子任务
		this.sendProgressUpdate({
			status: ControlTaskStatus.GENERATING_TEMPLATE,
			currentFileIndex: 1,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: 1,
			failedCount: 0,
			message: "正在生成指令模板...",
		})

		// 6. 先切换到 Loop 界面，让用户看到正在生成模板的状态
		this.provider.log(`[Control] Step 6: Switching to Loop view`)
		await new Promise((resolve) => setTimeout(resolve, 100))
		await this.provider.postMessageToWebview({
			type: "action",
			action: "controlButtonClicked",
		})

		// 7. 使用 LLM 根据处理规则生成指令模板
		this.provider.log(`[Control] Step 7: Calling LLM to enhance processing rule: ${processingRule}`)
		await this.generateInstructionTemplateFromRule(processingRule, validFiles)
		this.provider.log(`[Control] Instruction template generated: ${this.currentTask.instructionTemplate}`)

		// 8. 准备开始处理文件（不自动开始）
		this.provider.log(`[Control] Step 8: Ready to process ${validFiles.length} files`)
		this.provider.log(`[Control] Waiting for user to start processing...`)

		// 更新状态为等待用户操作
		this.sendProgressUpdate({
			status: ControlTaskStatus.PROCESSING,
			currentFileIndex: 1,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: 1,
			failedCount: 0,
			message: "等待处理下一个任务",
		})

		this.provider.log(`[Control] Ready for user action`)
	}

	/**
	 * 传统模式任务：保持原有流程
	 */
	private async startTraditionalModeTask(userPrompt: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		// 1. 解析提示词中的目录路径
		this.sendProgressUpdate({
			status: ControlTaskStatus.PARSING,
			currentFileIndex: 0,
			totalFiles: 0,
			completedCount: 0,
			failedCount: 0,
			message: "正在解析文件路径...",
		})

		const cwd = this.provider.cwd.toPosix()
		const pathInfo: ExtractedPathInfo = extractDirectoryFromPrompt(userPrompt, cwd)

		let targetDirectory = pathInfo.directory
		let effectivePrompt = pathInfo.cleanedPrompt || userPrompt

		// 如果没有指定目录,则对整个项目进行处理
		if (!pathInfo.hasPath) {
			targetDirectory = ""
			this.provider.log("[Control] No directory specified, processing entire project")
		} else {
			this.provider.log(`[Control] Target directory: ${targetDirectory}`)
		}

		// 2. 验证目录是否存在 (如果指定了目录)
		if (targetDirectory && !(await validateDirectory(targetDirectory, cwd))) {
			throw new Error(`目录不存在或无法访问: ${targetDirectory},${cwd}`)
		}

		// 3. 获取并过滤文件列表
		this.sendProgressUpdate({
			status: ControlTaskStatus.PARSING,
			currentFileIndex: 0,
			totalFiles: 0,
			completedCount: 0,
			failedCount: 0,
			message: "正在扫描文件...",
		})

		const files = await getFilteredFiles(targetDirectory || ".", cwd, 1000)

		if (files.length === 0) {
			throw new Error("没有找到需要处理的文件")
		}

		this.provider.log(`[Control] Found ${files.length} files to process`)

		// 4. 创建子任务列表
		const subTasks: SubTask[] = files.map((filePath) => ({
			id: uuidv4(),
			filePath,
			status: SubTaskStatus.PENDING,
			enabled: true,
		}))

		// 5. 初始化任务配置
		this.currentTask = {
			userPrompt: effectivePrompt,
			targetDirectory,
			files,
			subTasks,
		}

		// 6. 生成指令模板
		await this.generateInstructionTemplate(effectivePrompt, files)

		// 7. 等待用户手动开始处理（与规则模式保持一致）
		// 生成模板后，显示进度并等待用户点击"开始下一个任务"
		this.sendProgressUpdate({
			status: ControlTaskStatus.PROCESSING,
			currentFileIndex: 0,
			totalFiles: subTasks.length,
			completedCount: 0,
			failedCount: 0,
			message: "等待处理下一个任务",
		})

		this.provider.log(`[Control] Ready for user action (traditional mode)`)
	}

	/**
	 * 带重试机制的模型调用包装函数
	 * @param apiCall 要执行的 API 调用函数
	 * @param maxRetries 最大重试次数，默认为 3
	 * @param initialDelay 初始延迟时间（毫秒），默认为 1000
	 * @returns API 调用结果
	 */
	private async callWithRetry<T>(
		apiCall: () => Promise<T>,
		maxRetries: number = 3,
		initialDelay: number = 1000,
	): Promise<T> {
		let lastError: Error | undefined

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const result = await apiCall()

				// 成功则返回结果
				if (attempt > 0) {
					this.provider?.log(`[Control] API call succeeded on attempt ${attempt + 1}`)
				}
				return result
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))

				const hasMoreAttempts = attempt < maxRetries - 1

				this.provider?.log(
					`[Control] API call failed (attempt ${attempt + 1}/${maxRetries}): ${lastError.message}`,
				)

				if (!hasMoreAttempts) {
					// 没有更多重试机会，抛出错误
					break
				}

				// 计算延迟时间（指数退避）
				const delayMs = initialDelay * Math.pow(2, attempt)

				this.provider?.log(`[Control] Retrying in ${delayMs}ms...`)

				// 等待后重试
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
		}

		// 所有重试都失败，抛出最后的错误
		throw lastError || new Error("API call failed after all retries")
	}

	/**
	 * 生成指令模板（传统模式）
	 * 让模型根据用户提示词生成一个可复用的指令模板
	 */
	private async generateInstructionTemplate(userPrompt: string, files: string[]): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		this.sendProgressUpdate({
			status: ControlTaskStatus.GENERATING_TEMPLATE,
			currentFileIndex: 0,
			totalFiles: files.length,
			completedCount: 0,
			failedCount: 0,
			message: "正在生成指令模板...",
		})

		// 构建提示词,让模型生成模板
		const templatePrompt = `我需要对以下文件列表进行批量处理。请根据我的需求生成一个可复用的指令模板。

用户需求: ${userPrompt}

文件列表 (共 ${files.length} 个文件):
${files.slice(0, 10).join("\n")}
${files.length > 10 ? `\n... 还有 ${files.length - 10} 个文件` : ""}

请生成一个指令模板,该模板将应用于每个文件。模板中使用 {filePath} 作为文件路径的占位符。

要求:
1. 指令应该简洁明确
2. 适用于批量处理
3. 保持用户原始需求的核心意图

请直接输出指令模板,不要有其他解释。`

		try {
			// 获取当前的 API 配置
			const state = await this.provider.getState()
			const apiConfiguration = state.apiConfiguration

			// 使用重试机制调用模型生成指令模板
			const template = await this.callWithRetry(
				() =>
					singleCompletionHandler(
						apiConfiguration,
						templatePrompt,
						"你是一个专业的任务规划助手，帮助用户生成清晰、简洁的批量处理指令模板。",
						{ language: state.language },
					),
				3, // 最多重试 3 次
				1000, // 初始延迟 1 秒
			)

			if (this.currentTask) {
				this.currentTask.instructionTemplate = template.trim()
			}

			this.provider.log(`[Control] Generated template: ${template}`)
		} catch (error) {
			this.provider.log(`[Control] Failed to generate template after all retries: ${error}`)
			// 如果生成失败,使用默认模板（直接使用用户原始提示词）
			if (this.currentTask) {
				this.currentTask.instructionTemplate = userPrompt
				this.provider.log(`[Control] Using fallback template: ${userPrompt}`)
			}
		}
	}

	/**
	 * 根据规则生成指令模板（规则模式）
	 * 让模型根据处理规则生成包含 {{file}} 占位符的指令模板
	 */
	private async generateInstructionTemplateFromRule(processingRule: string, files: string[]): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		this.sendProgressUpdate({
			status: ControlTaskStatus.GENERATING_TEMPLATE,
			currentFileIndex: 0,
			totalFiles: files.length,
			completedCount: 0,
			failedCount: 0,
			message: "正在生成指令模板...",
		})

		// 构建提示词,让模型生成模板
		const templatePrompt = `你需要将用户的处理规则转换为一个清晰、可执行的指令模板。

【用户的处理规则】
${processingRule}

【目标文件列表】（共 ${files.length} 个文件）
${files.slice(0, 10).join("\n")}
${files.length > 10 ? `\n... 还有 ${files.length - 10} 个文件` : ""}

【任务】
请将上述处理规则转换为一个具体的、可操作的指令模板。这个模板将被应用到上述每个文件。

【关键要求】
1. 模板中必须包含 {{file}} 占位符（注意是双花括号）
2. 指令要具体明确，让 AI 助手能够理解具体要做什么
3. 指令应该是一个完整的、可直接执行的任务描述
4. 保持用户原始处理规则的核心意图和要求

【输出格式示例】
✓ 正确："为 {{file}} 中的所有导出函数添加 JSDoc 文档注释，包括参数说明、返回值说明和使用示例"
✓ 正确："分析 {{file}} 的代码质量，检查是否存在未使用的导入、冗余代码、潜在的性能问题，并提供优化建议"
✓ 正确："将 {{file}} 中的所有 console.log 语句替换为 logger.debug，保持原有的日志内容不变"
✗ 错误："优化代码"（太笼统，没有 {{file}} 占位符）
✗ 错误："处理文件"（没有说明具体要做什么）

【重要提示】
- 请务必包含 {{file}} 占位符（使用双花括号，不是单花括号）
- 如果用户的规则比较简单，请适当扩展以便 AI 助手更好地理解
- 如果用户的规则已经很具体，可以保持原样但确保包含 {{file}} 占位符

【输出】
请直接输出一条指令模板，不要包含任何解释、引号或其他内容。`

		try {
			// 获取当前的 API 配置
			const state = await this.provider.getState()
			const apiConfiguration = state.apiConfiguration

			// 使用重试机制调用模型生成指令模板
			const template = await this.callWithRetry(
				() =>
					singleCompletionHandler(
						apiConfiguration,
						templatePrompt,
						"你是一个专业的指令模板生成助手。你的任务是将用户的简单处理规则转换为具体、清晰、可操作的指令模板。你必须在输出中包含 {{file}} 占位符（双花括号）。你只输出指令模板本身，不要添加任何解释、引号或额外内容。",
						{ language: state.language },
					),
				3, // 最多重试 3 次
				1000, // 初始延迟 1 秒
			)

			const trimmedTemplate = template.trim()

			// 验证模板是否包含 {{file}} 占位符
			if (!trimmedTemplate.includes("{{file}}")) {
				this.provider.log(
					`[Control] Warning: Generated template does not contain {{file}} placeholder. Template: ${trimmedTemplate}`,
				)
				// 如果模板不包含占位符，尝试自动添加
				const fixedTemplate = `对 {{file}} 进行以下处理：${trimmedTemplate}`
				this.provider.log(`[Control] Using fixed template: ${fixedTemplate}`)
				if (this.currentTask) {
					this.currentTask.instructionTemplate = fixedTemplate
				}
			} else {
				if (this.currentTask) {
					this.currentTask.instructionTemplate = trimmedTemplate
				}
				this.provider.log(`[Control] Generated template: ${trimmedTemplate}`)
			}
		} catch (error) {
			this.provider.log(`[Control] Failed to generate template after all retries: ${error}`)
			// 如果生成失败,使用默认模板
			if (this.currentTask) {
				const fallbackTemplate = `对 {{file}} 进行以下处理：${processingRule}`
				this.currentTask.instructionTemplate = fallbackTemplate
				this.provider.log(`[Control] Using fallback template: ${fallbackTemplate}`)
			}
		}
	}

	/**
	 * 继续处理下一个启用的任务
	 */
	public async continueNextTask(): Promise<void> {
		if (!this.provider || !this.currentTask) {
			this.provider?.log("[Control] No current task, cannot continue")
			return
		}

		const { subTasks } = this.currentTask
		const startIndex = this.currentTask.isRuleMode ? 1 : 0

		// 查找下一个启用且未完成的任务
		const nextTaskIndex = subTasks.findIndex(
			(task, index) => index >= startIndex && task.enabled && task.status === SubTaskStatus.PENDING,
		)

		if (nextTaskIndex === -1) {
			this.provider.log("[Control] No more enabled pending tasks")
			// 所有任务完成，切换到 Loop 界面显示结果
			await this.completeAllTasks()
			return
		}

		this.provider.log(`[Control] Continuing with task ${nextTaskIndex}: ${subTasks[nextTaskIndex].filePath}`)
		await this.processSingleTaskAtIndex(nextTaskIndex)
	}

	/**
	 * 处理指定索引的单个任务
	 */
	private async processSingleTaskAtIndex(index: number): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		const { subTasks, instructionTemplate } = this.currentTask
		const subTask = subTasks[index]

		// 计算实际处理的文件数（排除文件发现任务）
		const startIndex = this.currentTask.isRuleMode ? 1 : 0
		const actualFileCount = subTasks.filter((t, i) => i >= startIndex && t.enabled).length
		const completedCount = subTasks.filter((t, i) => i >= startIndex && t.status === SubTaskStatus.COMPLETED).length
		const currentFileNumber = completedCount + 1

		// 更新子任务状态为运行中
		subTask.status = SubTaskStatus.RUNNING
		subTask.startTime = Date.now()

		this.sendProgressUpdate({
			status: ControlTaskStatus.PROCESSING,
			currentFileIndex: index,
			totalFiles: subTasks.length,
			currentSubTask: subTask,
			completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: `正在处理: ${subTask.filePath} (${currentFileNumber}/${actualFileCount})`,
		})

		try {
			// 切换到对话界面，让用户可以与AI交互
			this.provider.log("[Control] Starting subtask, switching to chat view")
			await this.provider.postMessageToWebview({
				type: "action",
				action: "hideControlView",
			})
			await new Promise((resolve) => setTimeout(resolve, 100))

			// 处理单个文件
			await this.processSingleFile(subTask, instructionTemplate || "")

			// 标记为完成
			subTask.status = SubTaskStatus.COMPLETED
			subTask.endTime = Date.now()
			this.provider.log(`[Control] Completed: ${subTask.filePath}`)
		} catch (error) {
			// 标记为失败
			subTask.status = SubTaskStatus.FAILED
			subTask.error = error instanceof Error ? error.message : String(error)
			subTask.endTime = Date.now()
			this.provider.log(`[Control] Failed: ${subTask.filePath}, Error: ${subTask.error}`)
		}

		// 更新进度
		this.sendProgressUpdate({
			status: ControlTaskStatus.PROCESSING,
			currentFileIndex: index + 1,
			totalFiles: subTasks.length,
			currentSubTask: subTask,
			completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: `已完成 ${currentFileNumber}/${actualFileCount} 个文件`,
		})

		// 任务完成后，检查是否还有待处理的任务
		const hasMorePendingTasks = subTasks.some(
			(t, i) => i >= startIndex && t.enabled && t.status === SubTaskStatus.PENDING,
		)

		if (!hasMorePendingTasks) {
			// 所有启用的任务都已完成，结束整个流程
			this.provider.log("[Control] All enabled tasks completed, finalizing...")
			await this.completeAllTasks()
		} else {
			// 还有待处理任务，切换回 Loop 界面等待用户操作
			this.provider.log("[Control] Task completed, switching back to Loop view for next task")
			await new Promise((resolve) => setTimeout(resolve, 100))
			await this.provider.postMessageToWebview({
				type: "action",
				action: "controlButtonClicked",
			})
		}
	}

	/**
	 * 完成所有任务
	 */
	private async completeAllTasks(): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		const { subTasks } = this.currentTask

		this.sendProgressUpdate({
			status: ControlTaskStatus.COMPLETED,
			currentFileIndex: subTasks.length,
			totalFiles: subTasks.length,
			completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: "所有任务已完成",
		})

		this.provider.log("[Control] All tasks completed")
		this.cleanup()

		await new Promise((resolve) => setTimeout(resolve, 100))
		await this.provider.postMessageToWebview({
			type: "action",
			action: "controlButtonClicked",
		})
	}

	/**
	 * 串行处理所有文件（传统模式使用）
	 */
	private async processFilesSequentially(): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		const { subTasks, instructionTemplate } = this.currentTask

		// 跳过第一个任务如果是文件发现任务
		const startIndex = this.currentTask.isRuleMode ? 1 : 0

		for (let i = startIndex; i < subTasks.length; i++) {
			// 检查是否需要取消
			if (this.shouldCancel) {
				this.provider.log("[Control] Task cancelled by user")
				this.sendProgressUpdate({
					status: ControlTaskStatus.CANCELLED,
					currentFileIndex: i,
					totalFiles: subTasks.length,
					completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
					failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
					message: "任务已取消",
				})

				this.provider.log("[Control] Task cancelled, switching back to Loop view")

				// 清理状态
				this.cleanup()

				// 等待一小段时间确保进度更新消息被处理
				await new Promise((resolve) => setTimeout(resolve, 100))

				// 任务取消后，自动切换回 Loop 界面
				await this.provider.postMessageToWebview({
					type: "action",
					action: "controlButtonClicked",
				})

				return
			}

			this.currentSubTaskIndex = i
			const subTask = subTasks[i]

			// 更新子任务状态为运行中
			subTask.status = SubTaskStatus.RUNNING
			subTask.startTime = Date.now()

			// 计算实际处理的文件数（排除文件发现任务）
			const actualFileCount = subTasks.length - startIndex
			const currentFileNumber = i - startIndex + 1

			this.sendProgressUpdate({
				status: ControlTaskStatus.PROCESSING,
				currentFileIndex: i,
				totalFiles: subTasks.length,
				currentSubTask: subTask,
				completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message: `正在处理: ${subTask.filePath} (${currentFileNumber}/${actualFileCount})`,
			})

			try {
				// 处理单个文件
				await this.processSingleFile(subTask, instructionTemplate || "")

				// 标记为完成
				subTask.status = SubTaskStatus.COMPLETED
				subTask.endTime = Date.now()
				this.provider.log(`[Control] Completed: ${subTask.filePath}`)
			} catch (error) {
				// 标记为失败
				subTask.status = SubTaskStatus.FAILED
				subTask.error = error instanceof Error ? error.message : String(error)
				subTask.endTime = Date.now()
				this.provider.log(`[Control] Failed: ${subTask.filePath}, Error: ${subTask.error}`)
			}

			// 更新进度
			this.sendProgressUpdate({
				status: ControlTaskStatus.PROCESSING,
				currentFileIndex: i + 1,
				totalFiles: subTasks.length,
				currentSubTask: subTask,
				completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message: `已完成 ${currentFileNumber}/${actualFileCount} 个文件`,
			})
		}

		// 所有文件处理完成
		this.sendProgressUpdate({
			status: ControlTaskStatus.COMPLETED,
			currentFileIndex: subTasks.length,
			totalFiles: subTasks.length,
			completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: "所有文件处理完成",
		})

		this.provider.log("[Control] All files processed, switching back to Loop view")

		// 清理状态（但保留 currentTask 以便查看结果）
		this.cleanup()

		// 等待一小段时间确保进度更新消息被处理
		await new Promise((resolve) => setTimeout(resolve, 100))

		// 所有子任务完成后，自动切换回 Loop 界面展示完整状态
		await this.provider.postMessageToWebview({
			type: "action",
			action: "controlButtonClicked",
		})

		this.provider.log("[Control] Switched to Loop view")
	}

	/**
	 * 处理单个文件
	 * 创建一个子任务并等待其完成
	 */
	private async processSingleFile(subTask: SubTask, template: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		// 根据模式确定占位符和替换逻辑
		const isRuleMode = this.currentTask?.isRuleMode || false
		let instruction: string

		if (isRuleMode) {
			// 规则模式：替换 {{file}} 占位符
			instruction = template.replace(/\{\{file\}\}/g, `@/${subTask.filePath}`)
		} else {
			// 传统模式：替换 {filePath} 占位符
			instruction = template.replace(/\{filePath\}/g, `@/${subTask.filePath}`)
		}

		this.provider.log(`[Control] Processing file: ${subTask.filePath}`)
		this.provider.log(`[Control] Instruction: ${instruction}`)

		try {
			// 创建一个新的对话任务
			const task = await this.provider.createTask(instruction, [])

			// 保存任务 ID，用于后续查看
			subTask.taskId = task.taskId
			// 手动触发一次进度更新，确保 taskId 同步到 UI
			if (this.currentTask) {
				const { subTasks } = this.currentTask
				this.sendProgressUpdate({
					status: ControlTaskStatus.PROCESSING,
					currentFileIndex: this.currentSubTaskIndex,
					totalFiles: subTasks.length,
					completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
					failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
					currentSubTask: subTask,
					message: `正在处理: ${subTask.filePath} (任务ID: ${subTask.taskId})`,
				})
			}

			// 自动跳转到该对话任务
			await this.provider.showTaskWithId(task.taskId)

			// 等待任务完成
			await this.waitForTaskCompletion(task)

			this.provider.log(`[Control] Task completed for file: ${subTask.filePath}`)
		} catch (error) {
			this.provider.log(`[Control] Task failed for file: ${subTask.filePath}, error: ${error}`)
			throw error
		}
	}

	/**
	 * 等待任务完成
	 * 监听任务状态变化,当任务完成或失败时返回
	 */
	private async waitForTaskCompletion(task: any): Promise<void> {
		return new Promise((resolve, reject) => {
			let isResolved = false

			// 设置超时 (例如 5 分钟)
			const timeout = setTimeout(
				() => {
					if (!isResolved) {
						isResolved = true
						reject(new Error("任务超时"))
					}
				},
				5 * 60 * 1000,
			)

			// 监听任务完成事件
			const checkTaskStatus = () => {
				// 检查任务是否已完成
				const currentTask = this.provider?.getCurrentTask()

				// 如果当前任务不是我们创建的任务,说明任务已经完成
				if (!currentTask || currentTask !== task) {
					if (!isResolved) {
						isResolved = true
						clearTimeout(timeout)
						this.provider?.log(`[Control] Task completed: ${task.taskId}`)
						resolve()
					}
					return
				}

				// 继续等待
				setTimeout(checkTaskStatus, 500)
			}

			// 开始检查
			setTimeout(checkTaskStatus, 500)
		})
	}

	/**
	 * 获取任务的响应文本
	 * @param task 任务对象
	 * @returns 任务的最终响应文本
	 */
	private getTaskResponse(task: any): string {
		if (!task) {
			return ""
		}

		// 尝试从任务的 apiConversationHistory 中获取最后的助手响应
		if (task.apiConversationHistory && Array.isArray(task.apiConversationHistory)) {
			// 从后往前查找最后一个 assistant 角色的消息
			for (let i = task.apiConversationHistory.length - 1; i >= 0; i--) {
				const message = task.apiConversationHistory[i]
				if (message.role === "assistant") {
					// 如果内容是数组（多部分内容）
					if (Array.isArray(message.content)) {
						// 合并所有文本部分
						return message.content
							.filter((part: any) => part.type === "text")
							.map((part: any) => part.text)
							.join("\n")
					} else if (typeof message.content === "string") {
						return message.content
					}
				}
			}
		}

		// 如果没有找到，尝试从 clineMessages 获取
		if (task.clineMessages && Array.isArray(task.clineMessages)) {
			// 从后往前查找最后一个 say 类型的消息
			for (let i = task.clineMessages.length - 1; i >= 0; i--) {
				const message = task.clineMessages[i]
				if (message.type === "say" && message.say === "text") {
					return message.text || ""
				}
			}
		}

		return ""
	}

	/**
	 * 切换任务的启用状态
	 */
	public toggleTaskEnabled(taskId: string): void {
		if (!this.currentTask) {
			return
		}

		const task = this.currentTask.subTasks.find((t) => t.id === taskId)
		if (!task) {
			return
		}

		// 如果任务是PENDING，切换其状态
		if (task.status === SubTaskStatus.PENDING) {
			if (task.enabled) {
				// 从启用变为禁用：标记为CANCELLED
				task.enabled = false
				task.status = SubTaskStatus.CANCELLED
				task.endTime = Date.now()
				this.provider?.log(`[Control] Task cancelled by user: ${task.filePath}`)
			} else {
				// 从禁用变为启用：恢复为PENDING
				task.enabled = true
				task.status = SubTaskStatus.PENDING
				task.error = undefined
				task.endTime = undefined
				this.provider?.log(`[Control] Task re-enabled: ${task.filePath}`)
			}

			// 发送更新通知
			this.sendProgressUpdate({
				status: this.currentTask.isRuleMode ? ControlTaskStatus.PROCESSING : ControlTaskStatus.PROCESSING,
				currentFileIndex: this.currentSubTaskIndex + 1,
				totalFiles: this.currentTask.subTasks.length,
				completedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message:
					task.status === SubTaskStatus.CANCELLED
						? `已取消任务: ${task.filePath}`
						: `已重新启用任务: ${task.filePath}`,
			})
		} else if (task.status === SubTaskStatus.CANCELLED) {
			// 如果任务是CANCELLED，可以恢复为PENDING
			task.enabled = true
			task.status = SubTaskStatus.PENDING
			task.error = undefined
			task.endTime = undefined
			this.provider?.log(`[Control] Task re-enabled from cancelled: ${task.filePath}`)

			// 发送更新通知
			this.sendProgressUpdate({
				status: this.currentTask.isRuleMode ? ControlTaskStatus.PROCESSING : ControlTaskStatus.PROCESSING,
				currentFileIndex: this.currentSubTaskIndex + 1,
				totalFiles: this.currentTask.subTasks.length,
				completedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message: `已重新启用任务: ${task.filePath}`,
			})
		}
	}

	/**
	 * 取消当前任务
	 */
	public async cancelTask(): Promise<void> {
		if (!this.currentTask) {
			return
		}

		this.provider?.log("[Control] Terminating all tasks...")
		this.shouldCancel = true
		this.isProcessing = false

		// 将所有PENDING和RUNNING的任务标记为CANCELLED
		this.currentTask.subTasks.forEach((task) => {
			if (task.status === SubTaskStatus.PENDING || task.status === SubTaskStatus.RUNNING) {
				task.status = SubTaskStatus.CANCELLED
				task.enabled = false
				task.endTime = Date.now()
			}
		})

		// 发送最终状态更新
		this.sendProgressUpdate({
			status: ControlTaskStatus.CANCELLED,
			currentFileIndex: this.currentTask.subTasks.length,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: "任务已终止",
		})

		this.provider?.log("[Control] All tasks terminated")

		// 清理状态
		this.cleanup()

		// 切换回 Loop 界面
		await new Promise((resolve) => setTimeout(resolve, 100))
		await this.provider?.postMessageToWebview({
			type: "action",
			action: "controlButtonClicked",
		})
	}

	/**
	 * 发送进度更新到 webview
	 */
	private sendProgressUpdate(progress: ControlTaskProgress): void {
		if (!this.provider) {
			return
		}

		// 保存当前进度状态
		this.currentProgress = progress

		this.provider.postMessageToWebview({
			type: "controlProgress",
			progress,
			subTasks: this.currentTask?.subTasks || [],
		})
	}

	/**
	 * 清理资源
	 */
	private cleanup(): void {
		this.isProcessing = false
		this.currentSubTaskIndex = -1
		this.shouldCancel = false
		// 保留 currentTask 以便查看结果
	}

	/**
	 * 获取当前任务状态
	 */
	public getCurrentTask(): ControlTaskConfig | undefined {
		return this.currentTask
	}

	/**
	 * 获取当前进度状态
	 */
	public getCurrentProgress(): ControlTaskProgress | undefined {
		return this.currentProgress
	}

	/**
	 * 重置服务状态
	 */
	public reset(): void {
		this.currentTask = undefined
		this.currentProgress = undefined
		this.isProcessing = false
		this.currentSubTaskIndex = -1
		this.shouldCancel = false
	}
}
