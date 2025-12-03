// costrict change - used for the loop mode of costrict
/**
 * Loop 组件类型定义
 */

/**
 * 子任务状态
 */
export enum SubTaskStatus {
	PENDING = "pending",
	RUNNING = "running",
	COMPLETED = "completed",
	FAILED = "failed",
	CANCELLED = "cancelled",
}

/**
 * Loop 任务整体状态
 */
export enum LoopTaskStatus {
	IDLE = "idle",
	PARSING = "parsing",
	DISCOVERING_FILES = "discovering_files", // 新增：文件发现阶段
	GENERATING_TEMPLATE = "generating_template",
	PROCESSING = "processing",
	COMPLETED = "completed",
	FAILED = "failed",
	CANCELLED = "cancelled",
}

/**
 * 子任务定义
 */
export interface SubTask {
	id: string
	filePath: string
	status: SubTaskStatus
	enabled: boolean // 是否启用该任务
	taskId?: string // 对应的对话任务 ID，用于点击跳转
	error?: string
	progress?: number
	startTime?: number
	endTime?: number
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
