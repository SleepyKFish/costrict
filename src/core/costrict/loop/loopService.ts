import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { v4 as uuidv4 } from "uuid"
import type { ClineProvider } from "../../webview/ClineProvider"
import { type LoopTaskConfig, type LoopTaskProgress, type SubTask, LoopTaskStatus, SubTaskStatus } from "./types"
import { singleCompletionHandler } from "../../../utils/single-completion-handler"
import { parseRules, extractFileListFromResponse } from "./ruleParser"
import { type TaskEvents, RooCodeEventName } from "@roo-code/types"
import { CoIgnoreController } from "../codebase-index/CoIgnoreController"
import { isPathInIgnoredDirectory } from "../../../services/glob/ignore-utils"

/**
 * Loop 服务类 - 负责管理循环处理文件的整个流程
 */
export class LoopService {
	private static instance: LoopService | undefined
	private provider: ClineProvider | undefined
	private currentTask: LoopTaskConfig | undefined
	private currentProgress: LoopTaskProgress | undefined
	private isProcessing: boolean = false
	private currentSubTaskIndex: number = -1
	private shouldCancel: boolean = false

	private constructor() {}

	public static getInstance(): LoopService {
		if (!LoopService.instance) {
			LoopService.instance = new LoopService()
		}
		return LoopService.instance
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
	public async startLoopTask(userPrompt: string): Promise<void> {
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

			// 解析规则（仅支持规则模式）
			const rules = parseRules(userPrompt)

			if (!rules.isRuleMode) {
				throw new Error("请使用规则模式：#文件发现规则：xxx #文件处理规则：xxx")
			}

			// 启动规则模式任务
			await this.startRuleModeTask(rules.discoveryRule!, rules.processingRule!)
		} catch (error) {
			const completedCount =
				this.currentTask?.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length || 0
			const failedCount = this.currentTask?.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length || 0

			this.sendProgressUpdate({
				status: LoopTaskStatus.FAILED,
				currentFileIndex: this.currentSubTaskIndex + 1,
				totalFiles: this.currentTask?.files.length || 0,
				completedCount,
				failedCount,
				message: `任务失败: ${error instanceof Error ? error.message : String(error)}`,
			})

			// 清理状态
			this.cleanup()

			// 任务失败后，自动切换回 Loop 界面并清理
			await this.switchToLoopViewAndCleanup()
		}
	}

	/**
	 * 规则模式任务：先通过 AI 发现文件，再循环处理
	 */
	private async startRuleModeTask(discoveryRule: string, processingRule: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		// 1. 创建文件发现子任务记录
		const discoverySubTask: SubTask = {
			id: uuidv4(),
			filePath: "File Discovery Task",
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

		const cwd = this.provider.cwd
		const pathSeparator = path.sep
		const isWindows = pathSeparator === "\\"
		const examplePaths = isWindows
			? `"src\\\\components\\\\Button.tsx",\n  "src\\\\components\\\\Input.tsx",\n  "src\\\\utils\\\\helpers.ts"`
			: `"src/components/Button.tsx",\n  "src/components/Input.tsx",\n  "src/utils/helpers.ts"`

		// 构建文件发现提示词
		const discoveryPrompt = `TASK OBJECTIVE:
Based on the user's file discovery rules, precisely locate all files in the project that need to be processed, and save the results to the specified JSON file.

FILE DISCOVERY RULES:
${discoveryRule}

EXECUTION STEPS:
1. Understand Rule Intent: Deeply understand the user's file discovery rules, clarify the file types to search for, directory scope, matching patterns, etc.
2. Explore Project Structure: MUST use the list_files tool to browse the project directory structure and understand how the project is organized
3. Precisely Match Files: Find all files that meet the criteria according to the rules, ensuring:
   - MUST use list_files tool to verify files actually exist in the project (no fabrication or speculation)
   - Paths use relative path format relative to the project root directory
   - Exclude irrelevant files (such as node_modules, .git, build artifacts, etc.)
4. Save Results: Save the discovered file list to the .cospec/discovered-files.json file

MANDATORY: You MUST use the list_files tool in step 2 and 3. Do NOT rely on assumptions or prior knowledge about the project structure.

OUTPUT REQUIREMENTS:
1. File Path Format: Use the native OS path separator (${pathSeparator === "\\" ? "\\\\ for Windows" : "/ for Unix-like systems"}), relative to the project root directory ${cwd}
2. JSON Format: Standard JSON array, each element is a file path string
3. File Count Limit: Maximum 1000 files
4. Save Location: .cospec${pathSeparator}discovered-files.json (create the directory first if it doesn't exist)

JSON FILE FORMAT EXAMPLE:
[
  ${examplePaths}
]

CRITICAL NOTES:
- MUST use the list_files tool to explore directories and verify file existence
- MUST use the write tool to write results to the .cospec${pathSeparator}discovered-files.json file
- Only return files that actually exist; MUST use list_files tool to verify file existence (do NOT guess or fabricate file paths)
- Paths must be relative paths using the OS-native path separator (${pathSeparator === "\\" ? "\\\\" : "/"})
- If rules are ambiguous, make reasonable inferences based on common project structures and best practices
- Exclude files that obviously don't need processing (such as dependency packages, build artifacts, hidden files, etc.)

TASK COMPLETION CRITERIA:
Once you have successfully written the file list to the .cospec${pathSeparator}discovered-files.json file, the task is complete.
In your response, briefly explain:
- How many files were discovered
- What types or directories of files were mainly matched
- Files have been saved to .cospec${pathSeparator}discovered-files.json

Now please begin the file discovery task.`

		// 保存 discoveryTask 引用，用于后续获取响应
		let discoveryTask: any
		let validFiles: string[] = []

		try {
			// costrict change - Create File Discovery Task with high file limit enabled to list more files
			discoveryTask = await this.provider.createTask(discoveryPrompt, [], undefined, {
				zgsmHighListFilesLimit: true,
			})

			// 保存任务 ID
			discoverySubTask.taskId = discoveryTask.taskId

			// 立即跳转到该对话任务（不先显示 loop 界面）
			await this.showTaskAndHideLoop(discoveryTask.taskId)

			// 更新进度，同步 taskId 到 UI
			this.sendProgressUpdate({
				status: LoopTaskStatus.DISCOVERING_FILES,
				currentFileIndex: 0,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 0,
				message: "正在分析项目结构，发现文件...",
			})

			// 等待任务完成
			await this.waitForTaskCompletion(discoveryTask)

			// 2. 从 .cospec/discovered-files.json 文件中读取文件列表
			this.sendProgressUpdate({
				status: LoopTaskStatus.PARSING,
				currentFileIndex: 1,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 0,
				message: "正在读取文件列表...",
			})

			// 读取 .cospec/discovered-files.json 文件
			const discoveredFilesPath = path.join(this.provider.cwd, ".cospec", "discovered-files.json")
			let files: string[] = []

			try {
				const fileContent = await fs.readFile(discoveredFilesPath, "utf-8")
				files = JSON.parse(fileContent)
				console.log(`成功从 ${discoveredFilesPath} 读取到 ${files.length} 个文件`)
			} catch (error) {
				console.error("读取 .cospec/discovered-files.json 失败，尝试从任务响应中提取：", error)
				// 降级方案：从任务响应中提取文件列表
				const taskResponse = this.getTaskResponse(discoveryTask)
				files = extractFileListFromResponse(taskResponse)
				console.log(`从任务响应中提取到 ${files.length} 个文件`)
			}

			// 验证文件列表
			if (!Array.isArray(files) || files.length === 0) {
				throw new Error("未能从 .cospec/discovered-files.json 或任务响应中获取有效的文件列表")
			}

			console.log("files", files)
			// 3. 初始化 CoIgnoreController 来进行文件过滤
			const ignoreController = new CoIgnoreController(this.provider.cwd)
			await ignoreController.initialize()

			// 4. 验证文件是否存在并使用 CoIgnoreController 过滤
			for (const file of files) {
				// 规范化路径，移除开头的路径分隔符
				let filePath = file
				if (filePath.startsWith("/") || filePath.startsWith("\\")) {
					filePath = filePath.substring(1)
				}
				// 确保使用正确的路径分隔符
				filePath = filePath.replace(/[/\\]/g, path.sep)

				try {
					// 检查文件是否存在
					const fullPath = path.join(this.provider.cwd, filePath)
					const uri = vscode.Uri.file(fullPath)
					await vscode.workspace.fs.stat(uri)

					// 使用 CoIgnoreController 检查文件是否被忽略
					if (ignoreController.coignoreContentInitialized) {
						if (!ignoreController.validateAccess(fullPath)) {
							continue
						}
					}

					// 使用内置的忽略模式
					if (isPathInIgnoredDirectory(fullPath)) {
						continue
					}

					validFiles.push(filePath)
				} catch (error) {
					// 文件不存在或无法访问，跳过
				}
			}

			// 清理 CoIgnoreController
			ignoreController.dispose()
			if (validFiles.length === 0) {
				throw new Error("Failed to extract valid file list from File Discovery Task.")
			}

			// Successfully parsed, mark File Discovery Task as completed
			discoverySubTask.status = SubTaskStatus.COMPLETED
			discoverySubTask.endTime = Date.now()
		} catch (error) {
			discoverySubTask.status = SubTaskStatus.FAILED
			discoverySubTask.endTime = Date.now()
			discoverySubTask.error = error instanceof Error ? error.message : String(error)

			// 发送失败状态更新
			this.sendProgressUpdate({
				status: LoopTaskStatus.FAILED,
				currentFileIndex: 1,
				totalFiles: 1,
				completedCount: 0,
				failedCount: 1,
				message: `File Discovery Task failed: ${discoverySubTask.error}`,
			})

			// 切换回 Loop 界面显示错误并清理
			await this.switchToLoopViewAndCleanup()
			return
		}

		// 5. 创建处理文件的子任务列表
		const processingSubTasks: SubTask[] = validFiles.map((filePath) => ({
			id: uuidv4(),
			filePath,
			status: SubTaskStatus.PENDING,
			enabled: true, // 默认启用所有任务
		}))

		// 6. 更新任务配置（保留文件发现子任务）
		this.currentTask.files = validFiles
		this.currentTask.subTasks = [discoverySubTask, ...processingSubTasks]

		// 发送进度更新，显示所有子任务
		this.sendProgressUpdate({
			status: LoopTaskStatus.GENERATING_TEMPLATE,
			currentFileIndex: 1,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: 1,
			failedCount: 0,
			message: "正在生成指令模板...",
		})

		// 7. Clean up File Discovery Task and switch to Loop view, showing template generation status to user
		await this.switchToLoopViewAndCleanup()

		// 8. 使用 LLM 根据处理规则生成指令模板
		await this.generateInstructionTemplateFromRule(processingRule, validFiles)

		// 更新状态为正在准备处理
		this.sendProgressUpdate({
			status: LoopTaskStatus.PROCESSING,
			currentFileIndex: 1,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: 1,
			failedCount: 0,
			message: "正在准备处理第一个文件...",
		})

		// 等待界面更新
		await new Promise((resolve) => setTimeout(resolve, 500))

		// 自动开始第一个文件处理任务
		await this.continueNextTask()
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
				return result
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))

				const hasMoreAttempts = attempt < maxRetries - 1

				if (!hasMoreAttempts) {
					// 没有更多重试机会，抛出错误
					break
				}

				// 计算延迟时间（指数退避）
				const delayMs = initialDelay * Math.pow(2, attempt)

				// 等待后重试
				await new Promise((resolve) => setTimeout(resolve, delayMs))
			}
		}

		// 所有重试都失败，抛出最后的错误
		throw lastError || new Error("API call failed after all retries")
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
			status: LoopTaskStatus.GENERATING_TEMPLATE,
			currentFileIndex: 1,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: 1,
			failedCount: 0,
			message: "正在生成指令模板...",
		})

		// 构建提示词,让模型生成模板
		const templatePrompt = `Your task is to create an instruction template by keeping the user's original rule EXACTLY as written and naturally integrating the file reference.

USER'S PROCESSING RULE (MUST KEEP INTACT):
${processingRule}

YOUR TASK:
1. Copy the user's original rule word-for-word
2. Naturally integrate {{file}} where the target file should be referenced
   - Add minimal words (like "in", "to", "for") if needed to make it grammatically natural
   - Or simply place {{file}} at the most logical position
3. After the rule, add a "TASK DETAILS" section with execution steps

OUTPUT FORMAT:
	[User's original rule with {{file}} naturally integrated]
	TASK DETAILS:
	1. First specific action or verification step
	2. Second specific action or verification step
	3. Third specific action or verification step
	(Add more steps as needed to fully clarify the task)

GUIDELINES:
- Each task detail should be concrete and executable
- Focus on what needs to be checked, modified, or verified
- Keep steps clear and concise
- Ensure steps align with the user's original intent

⚠️ CRITICAL REQUIREMENT: Do NOT modify, rephrase, rewrite, or change ANY word from the user's rule above. Keep it EXACTLY as written.
⚠️ KEY POINT: Make {{file}} integration feel natural, as if it was part of the original sentence.

Now generate the instruction template:

`

		// 添加单文件处理强调说明
		const scopeEmphasis = `
CRITICAL CONSTRAINTS:
- Single-File Focus: Process ONLY the file represented by {{file}}. This is a strictly single-file operation.
- Pre-Check Requirement: Before making any modifications, verify whether {{file}} already meets the requirements.
- No-Change Handling: If {{file}} already satisfies the requirements, briefly explain why and consider the task complete without making changes.
- Context Awareness: You may read other files for context or reference, but modifications are strictly limited to {{file}}.
- Task Completion: The task is complete once {{file}} has been fully processed according to the specified requirements.
- Prohibited Actions: Do NOT perform cross-file modifications, project-wide changes, or batch operations.
- Strict Scope Enforcement: Your entire focus and operations must remain confined to the single specified file {{file}}.
`

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
						"You are an instruction template generator. Keep the user's original wording EXACTLY as written. Your only modifications: (1) naturally integrate {{file}} placeholder where the target file should be referenced - make it grammatically smooth and natural, (2) add a TASK DETAILS section with execution steps. The {{file}} should feel like it belongs in the sentence.",
						{ language: state.language },
					),
				3, // 最多重试 3 次
				1000, // 初始延迟 1 秒
			)

			const trimmedTemplate = template.trim()

			// 验证模板是否包含 {{file}} 占位符
			if (!trimmedTemplate.includes("{{file}}")) {
				// 如果模板不包含占位符，尝试自动添加
				const fixedTemplate = `对 {{file}} 进行以下处理：${trimmedTemplate}${scopeEmphasis}`
				if (this.currentTask) {
					this.currentTask.instructionTemplate = fixedTemplate
				}
			} else {
				if (this.currentTask) {
					this.currentTask.instructionTemplate = trimmedTemplate + scopeEmphasis
				}
			}
		} catch (error) {
			// 如果生成失败,使用默认模板
			if (this.currentTask) {
				const fallbackTemplate = `对 {{file}} 进行以下处理：${processingRule}${scopeEmphasis}`
				this.currentTask.instructionTemplate = fallbackTemplate
			}
		}
	}

	/**
	 * 继续处理下一个启用的任务
	 */
	public async continueNextTask(): Promise<void> {
		if (!this.provider || !this.currentTask) {
			return
		}

		const { subTasks } = this.currentTask
		// Skip the first task (File Discovery Task)
		const startIndex = 1

		// 查找下一个启用且未完成的任务
		const nextTaskIndex = subTasks.findIndex(
			(task, index) => index >= startIndex && task.enabled && task.status === SubTaskStatus.PENDING,
		)

		if (nextTaskIndex === -1) {
			// 所有任务完成，切换到 Loop 界面显示结果
			await this.completeAllTasks()
			return
		}

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

		// 更新子任务状态为运行中
		subTask.status = SubTaskStatus.RUNNING

		this.sendProgressUpdate({
			status: LoopTaskStatus.PROCESSING,
			currentFileIndex: index,
			totalFiles: subTasks.length,
			currentSubTask: subTask,
			completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: `正在处理: ${subTask.filePath}`,
		})

		try {
			// 处理单个文件（时间统计在 processSingleFile 内部进行）
			// processSingleFile 会自动跳转到对话任务并隐藏 loop 界面
			await this.processSingleFile(subTask, instructionTemplate || "")

			// 标记为完成
			subTask.status = SubTaskStatus.COMPLETED
		} catch (error) {
			// 标记为失败
			subTask.status = SubTaskStatus.FAILED
			subTask.error = error instanceof Error ? error.message : String(error)
		}

		// 任务完成后，检查是否还有待处理的任务
		const startIndex = 1 // Skip the File Discovery Task
		const hasMorePendingTasks = subTasks.some(
			(t, i) => i >= startIndex && t.enabled && t.status === SubTaskStatus.PENDING,
		)

		// 检查是否需要取消
		if (this.shouldCancel) {
			return
		}

		if (!hasMorePendingTasks) {
			// 所有启用的任务都已完成，结束整个流程
			// 更新进度显示完成信息
			this.sendProgressUpdate({
				status: LoopTaskStatus.PROCESSING,
				currentFileIndex: index + 1,
				totalFiles: subTasks.length,
				currentSubTask: subTask,
				completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message: `任务已完成`,
			})
			await this.completeAllTasks()
		} else {
			// 还有待处理任务，自动继续下一个任务

			// 更新进度，显示正在准备下一个任务
			this.sendProgressUpdate({
				status: LoopTaskStatus.PROCESSING,
				currentFileIndex: index + 1,
				totalFiles: subTasks.length,
				currentSubTask: subTask,
				completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
				failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
				message: `正在准备下一个任务...`,
			})

			// 先切换回 Loop 界面显示进度
			await this.switchToLoopViewAndCleanup()

			// 等待一小段时间确保界面更新完成
			await new Promise((resolve) => setTimeout(resolve, 500))

			// 自动继续下一个任务
			await this.continueNextTask()
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
		const completedCount = subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length
		const failedCount = subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length

		// Check if all tasks are completed (excluding File Discovery Task)
		const processingTasks = subTasks.slice(1) // Skip the first File Discovery Task
		const allTasksCompleted =
			processingTasks.length > 0 && processingTasks.every((t) => t.status === SubTaskStatus.COMPLETED)

		this.sendProgressUpdate({
			status: LoopTaskStatus.COMPLETED,
			currentFileIndex: subTasks.length,
			totalFiles: subTasks.length,
			completedCount,
			failedCount,
			message: allTasksCompleted ? "所有任务已完成" : "所有任务已结束",
		})

		this.cleanup()

		// 切换回 Loop 界面并清理
		await this.switchToLoopViewAndCleanup()
	}

	/**
	 * 处理单个文件
	 * 创建一个子任务并等待其完成
	 */
	private async processSingleFile(subTask: SubTask, template: string): Promise<void> {
		if (!this.provider) {
			throw new Error("Provider not set")
		}

		// 替换 {{file}} 占位符
		const instruction = template.replace(/\{\{file\}\}/g, `${subTask.filePath}`)

		try {
			// 创建一个新的对话任务
			const task = await this.provider.createTask(instruction, [])

			// 保存任务 ID，用于后续查看
			subTask.taskId = task.taskId
			// 手动触发一次进度更新，确保 taskId 同步到 UI
			if (this.currentTask) {
				const { subTasks } = this.currentTask
				this.sendProgressUpdate({
					status: LoopTaskStatus.PROCESSING,
					currentFileIndex: this.currentSubTaskIndex,
					totalFiles: subTasks.length,
					completedCount: subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
					failedCount: subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
					currentSubTask: subTask,
					message: `正在处理: ${subTask.filePath}`,
				})
			}

			// 自动跳转到该对话任务并隐藏 loop 界面
			await this.showTaskAndHideLoop(task.taskId)

			// 记录 AI 处理开始时间（在准备工作完成后）
			subTask.startTime = Date.now()

			// 等待任务完成
			await this.waitForTaskCompletion(task)

			// 记录 AI 处理结束时间（任务完成后立即记录）
			subTask.endTime = Date.now()
		} catch (error) {
			// 记录失败时的结束时间
			subTask.endTime = Date.now()
			throw error
		}
	}

	/**
	 * 等待任务完成
	 * 使用事件监听方式,当任务完成、中止或进入可恢复状态时返回
	 * 注意：已取消超时限制，任务将持续等待直到完成或失败
	 */
	private async waitForTaskCompletion(task: any): Promise<void> {
		return new Promise((resolve, reject) => {
			let isResolved = false

			// 事件处理器注册函数
			const registerHandler = <K extends keyof TaskEvents>(
				event: K,
				handler: (...args: TaskEvents[K]) => void | Promise<void>,
			) => {
				task.on(event, handler as any)
			}

			// 清理函数：移除所有事件监听器
			const cleanup = () => {
				task.removeAllListeners(RooCodeEventName.TaskCompleted)
				task.removeAllListeners(RooCodeEventName.TaskAborted)
				task.removeAllListeners(RooCodeEventName.TaskResumable)
				task.removeAllListeners(RooCodeEventName.TaskIdle)
			}

			// 监听任务完成事件
			registerHandler(RooCodeEventName.TaskCompleted, () => {
				if (!isResolved) {
					isResolved = true
					cleanup()
					resolve()
				}
			})

			// 监听任务中止事件
			registerHandler(RooCodeEventName.TaskAborted, () => {
				if (!isResolved) {
					isResolved = true
					cleanup()
					reject(new Error("任务已中止"))
				}
			})

			// 监听任务进入可恢复状态（通常表示需要用户介入）
			registerHandler(RooCodeEventName.TaskResumable, () => {
				if (!isResolved) {
					isResolved = true
					cleanup()
					reject(new Error("任务已中止"))
				}
			})

			// 监听任务进入空闲状态（通常表示服务不可用）
			registerHandler(RooCodeEventName.TaskIdle, () => {
				if (!isResolved) {
					isResolved = true
					cleanup()
					reject(new Error("任务已中止"))
				}
			})
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

		// 从 clineMessages 获取最后的文本消息
		if (task.clineMessages && Array.isArray(task.clineMessages)) {
			// 从后往前查找后两个 say 类型的文本消息
			const messages = [...task.clineMessages]
				.reverse()
				.filter((msg) => msg.type === "say" && msg.text)
				.slice(0, 4) // 取前四个（已经是倒序，所以是最后四个）
			// 最后一个消息可能不会输出文件列表，所以后两个
			if (messages.length > 0) {
				// 合并后两个消息的文本（倒序回来，保持原始顺序）
				return messages
					.reverse()
					.map((msg) => msg.text)
					.join("\n")
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
			} else {
				// 从禁用变为启用：恢复为PENDING
				task.enabled = true
				task.status = SubTaskStatus.PENDING
				task.error = undefined
				task.endTime = undefined
			}

			// 发送更新通知
			this.sendProgressUpdate({
				status: LoopTaskStatus.PROCESSING,
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

			// 发送更新通知
			this.sendProgressUpdate({
				status: LoopTaskStatus.PROCESSING,
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
			status: LoopTaskStatus.CANCELLED,
			currentFileIndex: this.currentTask.subTasks.length,
			totalFiles: this.currentTask.subTasks.length,
			completedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.COMPLETED).length,
			failedCount: this.currentTask.subTasks.filter((t) => t.status === SubTaskStatus.FAILED).length,
			message: "任务已终止",
		})

		// 清理状态
		this.cleanup()

		// 切换回 Loop 界面并清理
		await this.switchToLoopViewAndCleanup()
	}

	/**
	 * 跳转到指定任务并隐藏 loop 界面
	 */
	private async showTaskAndHideLoop(taskId: string): Promise<void> {
		if (!this.provider) {
			return
		}

		// costrict change - 先跳转到对话任务
		await this.provider.showTaskWithId(taskId)
		await new Promise((resolve) => setTimeout(resolve, 25))
		// 然后隐藏 loop 界面
		await this.provider.postMessageToWebview({
			type: "action",
			action: "zgsmHideLoopView",
		})
	}

	/**
	 * 切换回 Loop 界面并执行清理
	 * 封装了清理任务栈 + 刷新工作空间 + 跳转的完整流程
	 */
	private async switchToLoopViewAndCleanup(): Promise<void> {
		if (!this.provider) {
			return
		}

		// 等待一小段时间确保进度更新消息被处理
		await new Promise((resolve) => setTimeout(resolve, 100))

		// 先执行清理：移除任务栈并刷新工作空间
		await this.provider.removeClineFromStack()
		await this.provider.refreshWorkspace()

		// costrict change - 最后切换回 Loop 界面
		await this.provider.postMessageToWebview({
			type: "action",
			action: "zgsmLoopButtonClicked",
		})
	}

	/**
	 * costrict change - 发送进度更新到 webview
	 */
	private sendProgressUpdate(progress: LoopTaskProgress): void {
		if (!this.provider) {
			return
		}

		// 保存当前进度状态
		this.currentProgress = progress

		this.provider.postMessageToWebview({
			type: "zgsmLoopProgress",
			zgsmLoopProgress: progress,
			zgsmLoopSubTasks: this.currentTask?.subTasks || [],
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
	public getCurrentTask(): LoopTaskConfig | undefined {
		return this.currentTask
	}

	/**
	 * 获取当前进度状态
	 */
	public getCurrentProgress(): LoopTaskProgress | undefined {
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
