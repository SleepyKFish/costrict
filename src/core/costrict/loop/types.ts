// costrict change - used for the loop mode of costrict
/**
 * Loop 功能类型定义
 */

/**
 * 子任务状态
 */
export enum SubTaskStatus {
	PENDING = "pending", // 等待处理
	RUNNING = "running", // 正在运行
	COMPLETED = "completed", // 已完成
	FAILED = "failed", // 失败
	CANCELLED = "cancelled", // 已取消
}

/**
 * Loop 任务整体状态
 */
export enum LoopTaskStatus {
	IDLE = "idle", // 空闲
	PARSING = "parsing", // 正在解析文件
	DISCOVERING_FILES = "discovering_files", // 正在发现文件（规则模式）
	GENERATING_TEMPLATE = "generating_template", // 正在生成模板
	PROCESSING = "processing", // 正在处理文件
	COMPLETED = "completed", // 已完成
	FAILED = "failed", // 失败
	CANCELLED = "cancelled", // 已取消
}

/**
 * 子任务定义
 */
export interface SubTask {
	id: string
	filePath: string // 相对路径
	status: SubTaskStatus
	enabled: boolean // 是否启用该任务
	taskId?: string // 对应的对话任务 ID，用于点击跳转
	error?: string
	progress?: number
	startTime?: number
	endTime?: number
}

/**
 * Loop 任务配置
 */
export interface LoopTaskConfig {
	userPrompt: string // 用户输入的提示词
	targetDirectory: string // 目标目录
	instructionTemplate?: string // 生成的指令模板
	files: string[] // 过滤后的文件列表
	subTasks: SubTask[]
	// 规则模式相关字段
	discoveryRule?: string // 文件发现规则
	processingRule?: string // 文件处理规则
	isRuleMode?: boolean // 是否为规则模式
}

/**
 * Loop 任务进度信息
 */
export interface LoopTaskProgress {
	status: LoopTaskStatus
	currentFileIndex: number
	totalFiles: number
	currentSubTask?: SubTask
	completedCount: number
	failedCount: number
	message?: string
}

/**
 * 从用户提示词中提取的路径信息
 */
export interface ExtractedPathInfo {
	directory: string // 提取的目录路径
	hasPath: boolean // 是否包含路径
	cleanedPrompt: string // 移除路径后的提示词
}

/**
 * 解析后的规则信息
 */
export interface ParsedRules {
	isRuleMode: boolean // 是否为规则模式
	discoveryRule?: string // 文件发现规则
	processingRule?: string // 文件处理规则
}
