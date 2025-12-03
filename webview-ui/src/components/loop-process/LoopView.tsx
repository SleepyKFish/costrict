import React, { useState, useCallback, useEffect, useRef } from "react"
import { vscode } from "../../utils/vscode"
import { type LoopTaskProgress, type SubTask, LoopTaskStatus, SubTaskStatus } from "./types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { cn } from "../../lib/utils"
import { ChatTextArea } from "../chat/ChatTextArea"
import { useExtensionState } from "@src/context/ExtensionStateContext"

interface LoopViewProps {
	isHidden?: boolean
	onSwitchToChat?: () => void
}

/**
 * Loop 主界面组件
 */
const LoopView: React.FC<LoopViewProps> = ({ isHidden, onSwitchToChat }) => {
	const { mode, setMode } = useExtensionState()
	const textAreaRef = useRef<HTMLTextAreaElement>(null)

	const [userPrompt, setUserPrompt] = useState("")
	const [progress, setProgress] = useState<LoopTaskProgress | null>(null)
	const [subTasks, setSubTasks] = useState<SubTask[]>([])
	const [isStarted, setIsStarted] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [displayMessage, setDisplayMessage] = useState<string>("")
	const messageTimerRef = useRef<NodeJS.Timeout | null>(null)

	// costrict change - 处理来自扩展的消息
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			switch (message.type) {
				case "zgsmLoopProgress":
					setProgress(message.zgsmLoopProgress)
					if (message.zgsmLoopSubTasks) {
						setSubTasks(message.zgsmLoopSubTasks)
					}
					// costrict change - 检查任务是否完成或失败
					if (
						message.zgsmLoopProgress.status === LoopTaskStatus.COMPLETED ||
						message.zgsmLoopProgress.status === LoopTaskStatus.FAILED ||
						message.zgsmLoopProgress.status === LoopTaskStatus.CANCELLED
					) {
						// 任务结束，确保显示完整的子任务列表
						setIsStarted(true)
					}
					break
				case "zgsmLoopStateResponse":
					// costrict change - 收到完整的任务状态
					if (message.zgsmLoopTask) {
						const task = message.zgsmLoopTask
						setUserPrompt(task.userPrompt || "")
						setSubTasks(task.subTasks || [])
						setIsStarted(true)

						// costrict change - 如果后端提供了 progress，直接使用它（这样可以保留 GENERATING_TEMPLATE 等状态）
						if (message.zgsmLoopProgress) {
							setProgress(message.zgsmLoopProgress)
						} else {
							// 否则根据子任务状态重建进度信息
							const completedCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.COMPLETED,
							).length
							const failedCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.FAILED,
							).length
							const cancelledCount = task.subTasks.filter(
								(t: any) => t.status === SubTaskStatus.CANCELLED,
							).length
							const runningTask = task.subTasks.find((t: any) => t.status === SubTaskStatus.RUNNING)
							const hasPendingEnabledTasks = task.subTasks.some(
								(t: any) => t.status === SubTaskStatus.PENDING && t.enabled !== false,
							)

							// 判断任务整体状态
							let taskStatus = LoopTaskStatus.PROCESSING
							if (runningTask) {
								taskStatus = LoopTaskStatus.PROCESSING
							} else if (hasPendingEnabledTasks) {
								// 有待处理的启用任务，状态应该是PROCESSING
								taskStatus = LoopTaskStatus.PROCESSING
							} else if (completedCount + failedCount + cancelledCount === task.subTasks.length) {
								// 所有任务都已完成/失败/取消
								// 如果有待处理任务但都被取消了，状态是CANCELLED
								// 否则是COMPLETED
								const allNonCompletedAreCancelled = task.subTasks.every(
									(t: any) =>
										t.status === SubTaskStatus.COMPLETED || t.status === SubTaskStatus.CANCELLED,
								)
								if (cancelledCount > 0 && allNonCompletedAreCancelled && completedCount === 0) {
									// 没有完成任何任务，所有都是取消的，说明是整体终止
									taskStatus = LoopTaskStatus.CANCELLED
								} else {
									taskStatus = LoopTaskStatus.COMPLETED
								}
							}

							// Check if all tasks are completed (excluding File Discovery Task)
							const processingTasks = task.subTasks.slice(1) // Skip the first File Discovery Task
							const allTasksCompleted =
								processingTasks.length > 0 &&
								processingTasks.every((t: any) => t.status === SubTaskStatus.COMPLETED)

							setProgress({
								status: taskStatus,
								currentFileIndex: completedCount + failedCount + cancelledCount,
								totalFiles: task.subTasks.length,
								completedCount,
								failedCount,
								message:
									taskStatus === LoopTaskStatus.CANCELLED
										? "任务已终止"
										: taskStatus === LoopTaskStatus.COMPLETED
											? allTasksCompleted
												? "所有任务已完成"
												: "所有任务已结束"
											: hasPendingEnabledTasks
												? "等待处理下一个任务"
												: `正在处理: ${runningTask?.filePath || ""}`,
							})
						}
					}
					break
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// costrict change - 组件显示时，请求当前任务状态
	useEffect(() => {
		if (!isHidden) {
			// 请求后端的当前任务状态
			vscode.postMessage({
				type: "zgsmRequestLoopState",
			})
		}
	}, [isHidden])

	// 处理状态栏消息显示逻辑：优先显示正在执行的任务
	useEffect(() => {
		// 清除之前的定时器
		if (messageTimerRef.current) {
			clearTimeout(messageTimerRef.current)
			messageTimerRef.current = null
		}

		if (!progress) {
			setDisplayMessage("")
			return
		}

		// 查找正在执行的任务
		const runningTask = subTasks.find((t) => t.status === SubTaskStatus.RUNNING)

		if (runningTask) {
			// 如果有正在执行的任务，优先显示它
			const runningMessage = `正在处理: ${runningTask.filePath}`
			setDisplayMessage(runningMessage)

			// 如果 progress.message 不是正在执行的消息，说明是临时状态消息
			// 显示 1 秒后切换回正在执行的任务
			if (progress.message && progress.message !== runningMessage) {
				setDisplayMessage(progress.message)
				messageTimerRef.current = setTimeout(() => {
					setDisplayMessage(runningMessage)
				}, 1000)
			}
		} else {
			// 没有正在执行的任务，直接显示 progress.message
			setDisplayMessage(progress.message || "")
		}

		// 清理函数
		return () => {
			if (messageTimerRef.current) {
				clearTimeout(messageTimerRef.current)
				messageTimerRef.current = null
			}
		}
	}, [progress, subTasks])

	// 开始 Loop 任务（仅支持规则模式）
	const handleStartTask = useCallback(() => {
		const input = userPrompt.trim()

		// costrict change - used for the loop mode of costrict
		// input一定是有内容的，基本上是无用的
		if (!input) {
			vscode.postMessage({
				type: "zgsmShowLoopWarning",
				text: "请输入任务内容",
			})
			return
		}

		// 检测是否为规则模式（只检查关键词，不限定格式）
		const hasDiscoveryRule = input.includes("文件发现规则")
		const hasProcessingRule = input.includes("文件处理规则")

		// costrict change - 只支持规则模式(used for the loop mode of costrict)
		if (!hasDiscoveryRule || !hasProcessingRule) {
			vscode.postMessage({
				type: "zgsmShowLoopWarning",
				text: "Loop 模式的输入格式不正确，请检查后重试",
			})
			return
		}

		// costrict change - 直接发送用户输入的原始内容，让后端解析
		setIsStarted(true)
		vscode.postMessage({
			type: "zgsmStartLoopTask",
			text: input,
		})
	}, [userPrompt])

	// costrict change - 切换任务启用状态
	const handleToggleTaskEnabled = useCallback((taskId: string) => {
		vscode.postMessage({
			type: "zgsmToggleLoopTaskEnabled",
			zgsmLoopTaskId: taskId,
		})
	}, [])

	// costrict change - 取消任务
	const handleCancelTask = useCallback(() => {
		vscode.postMessage({
			type: "zgsmCancelLoopTask",
		})
	}, [])

	// costrict change - 重新开始
	const handleReset = useCallback(() => {
		setUserPrompt("")
		setProgress(null)
		setSubTasks([])
		setIsStarted(false)
		vscode.postMessage({
			type: "zgsmResetLoop",
		})
	}, [])

	// 返回到对话界面
	const handleBackToChat = useCallback(() => {
		if (onSwitchToChat) {
			onSwitchToChat()
		} else {
			vscode.postMessage({
				type: "switchTab",
				tab: "chat",
			})
		}
	}, [onSwitchToChat])

	// 渲染状态标签
	const renderStatusBadge = (status: SubTaskStatus) => {
		const statusConfig = {
			[SubTaskStatus.PENDING]: { label: "等待中", color: "text-gray-500", bgColor: "bg-gray-100" },
			[SubTaskStatus.RUNNING]: { label: "处理中", color: "text-blue-600", bgColor: "bg-blue-100" },
			[SubTaskStatus.COMPLETED]: { label: "已完成", color: "text-green-600", bgColor: "bg-green-100" },
			[SubTaskStatus.FAILED]: { label: "失败", color: "text-red-600", bgColor: "bg-red-100" },
			[SubTaskStatus.CANCELLED]: { label: "已取消", color: "text-orange-600", bgColor: "bg-orange-100" },
		}

		const config = statusConfig[status]
		return (
			<span
				className={cn(
					"px-2 py-1 rounded text-xs font-medium",
					config.color,
					config.bgColor,
					"dark:bg-opacity-20",
				)}>
				{config.label}
			</span>
		)
	}

	// 计算进度百分比
	const progressPercentage =
		progress && progress.totalFiles > 0
			? Math.round(((progress.completedCount + progress.failedCount) / progress.totalFiles) * 100)
			: 0

	// 是否正在处理
	const isProcessing =
		progress !== null &&
		(progress.status === LoopTaskStatus.PARSING ||
			progress.status === LoopTaskStatus.GENERATING_TEMPLATE ||
			progress.status === LoopTaskStatus.PROCESSING)

	return (
		<div className={cn("h-full flex flex-col overflow-hidden", isHidden && "hidden")}>
			{/* 头部标题栏 */}
			<div className="px-5 py-3 border-b border-vscode-editorGroup-border flex-shrink-0">
				<div className="flex items-center justify-between">
					<h2 className="text-base font-semibold">Loop 循环处理</h2>
					<button
						onClick={handleBackToChat}
						className="text-xs text-vscode-textLink-foreground hover:underline flex items-center gap-1">
						<i className="codicon codicon-arrow-left"></i>
						返回对话
					</button>
				</div>
			</div>

			{/* 进度信息区域 */}
			{progress && (
				<div className="px-5 py-3 flex-shrink-0 border-b border-vscode-editorGroup-border bg-vscode-editor-background">
					{/* 特殊状态提示框 */}
					{progress.status === LoopTaskStatus.DISCOVERING_FILES && (
						<div className="mb-3 p-3 rounded-lg bg-vscode-sideBar-background border border-vscode-editorGroup-border">
							<div className="text-sm font-semibold mb-1 flex items-center gap-2">
								<i className="codicon codicon-search text-blue-500"></i>
								正在发现文件
								<span className="inline-flex gap-1 items-center">
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.2s",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.4s",
										}}></span>
								</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground">
								AI 正在根据您的文件发现规则分析项目结构，查找需要处理的文件...
							</div>
						</div>
					)}

					{progress.status === LoopTaskStatus.PARSING && (
						<div className="mb-3 p-3 rounded-lg bg-vscode-sideBar-background border border-vscode-editorGroup-border">
							<div className="text-sm font-semibold mb-1 flex items-center gap-2">
								<i className="codicon codicon-file-code text-yellow-500"></i>
								正在解析文件列表
								<span className="inline-flex gap-1 items-center">
									<span
										className="inline-block w-1.5 h-1.5 bg-yellow-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-yellow-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.2s",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-yellow-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.4s",
										}}></span>
								</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground">
								正在从 AI 响应中提取并验证文件列表...
							</div>
						</div>
					)}

					{progress.status === LoopTaskStatus.GENERATING_TEMPLATE && (
						<div className="mb-3 p-3 rounded-lg bg-vscode-sideBar-background border border-vscode-editorGroup-border">
							<div className="text-sm font-semibold mb-1 flex items-center gap-2">
								<i className="codicon codicon-wand text-blue-500"></i>
								正在生成指令模板
								<span className="inline-flex gap-1 items-center">
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.2s",
										}}></span>
									<span
										className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full"
										style={{
											animation: "pulse 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
											animationDelay: "0.4s",
										}}></span>
								</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground">
								AI 正在根据您的处理规则生成可复用的指令模板，这将应用到所有文件...
							</div>
						</div>
					)}

					{/* 状态信息（特殊状态下不显示，避免重复） */}
					{progress.status !== LoopTaskStatus.DISCOVERING_FILES &&
						progress.status !== LoopTaskStatus.PARSING &&
						progress.status !== LoopTaskStatus.GENERATING_TEMPLATE && (
							<div className="mb-2">
								<div className="flex items-center justify-between mb-2">
									<div className="text-sm font-medium">{displayMessage || "处理中..."}</div>
									<div className="text-xs text-vscode-descriptionForeground">
										{progress.completedCount + progress.failedCount} / {progress.totalFiles}
									</div>
								</div>
							</div>
						)}

					{/* 进度条（始终显示） */}
					<div className="mb-2">
						<div className="w-full h-2 bg-vscode-progressBar-background rounded-full overflow-hidden">
							<div
								className="h-full bg-vscode-progressBar-foreground transition-all duration-300"
								style={{ width: `${progressPercentage}%` }}
							/>
						</div>
					</div>

					{/* 统计信息 */}
					<div className="flex items-center gap-4 text-xs mb-3">
						<div className="flex items-center gap-1">
							<span className="text-green-600">✓</span>
							<span>完成: {progress.completedCount}</span>
						</div>
						<div className="flex items-center gap-1">
							<span className="text-red-600">✗</span>
							<span>失败: {progress.failedCount}</span>
						</div>
						<div className="flex items-center gap-1">
							<span className="text-gray-500">○</span>
							<span>
								待处理: {subTasks.filter((t) => t.enabled && t.status === SubTaskStatus.PENDING).length}
							</span>
						</div>
					</div>

					{/* 操作按钮 */}
					<div className="flex gap-2">
						{/* 任务已终止，只显示结束任务按钮 */}
						{progress && progress.status === LoopTaskStatus.CANCELLED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 任务完成后显示结束任务按钮 */}
						{progress && progress.status === LoopTaskStatus.COMPLETED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 任务失败后显示结束任务按钮 */}
						{progress && progress.status === LoopTaskStatus.FAILED && (
							<VSCodeButton onClick={handleReset}>结束任务</VSCodeButton>
						)}

						{/* 特殊状态下的按钮 */}
						{progress && progress.status === LoopTaskStatus.DISCOVERING_FILES && (
							<VSCodeButton onClick={handleCancelTask} appearance="secondary">
								终止任务
							</VSCodeButton>
						)}

						{/* 任务进行中的按钮 */}
						{progress && progress.status === LoopTaskStatus.PROCESSING && (
							<>
								{/* 终止任务按钮 */}
								<VSCodeButton onClick={handleCancelTask} appearance="secondary">
									终止任务
								</VSCodeButton>
							</>
						)}
					</div>
				</div>
			)}

			{/* 中间内容区域 - 子任务列表或欢迎页 */}
			<div className="flex-1 overflow-y-auto">
				{subTasks.length > 0 ? (
					<div className="px-5 py-4">
						<h3 className="text-sm font-semibold mb-3">子任务列表</h3>
						<div className="space-y-2">
							{subTasks.map((task) => (
								<div
									key={task.id}
									className={cn(
										"p-3 rounded-lg border transition-colors border-vscode-editorGroup-border bg-vscode-editor-background",
										task.status === SubTaskStatus.CANCELLED && "opacity-60",
									)}>
									<div className="flex items-center justify-between mb-1">
										<div className="flex items-center gap-2 flex-1 min-w-0">
											{/* 启用/禁用复选框（仅在任务进行中且任务为PENDING或CANCELLED时显示） */}
											{progress &&
												progress.status === LoopTaskStatus.PROCESSING &&
												(task.status === SubTaskStatus.PENDING ||
													task.status === SubTaskStatus.CANCELLED) &&
												task.filePath !== "File Discovery Task" && (
													<button
														className={cn(
															"flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center transition-all cursor-pointer",
															task.status === SubTaskStatus.PENDING && task.enabled
																? "bg-green-500 border-green-500"
																: "bg-transparent border-gray-400 dark:border-gray-500",
														)}
														onClick={(e) => {
															e.stopPropagation()
															handleToggleTaskEnabled(task.id)
														}}
														title={
															task.status === SubTaskStatus.CANCELLED
																? "点击重新启用"
																: task.enabled
																	? "点击取消"
																	: "点击启用"
														}>
														{task.status === SubTaskStatus.PENDING && task.enabled && (
															<svg
																className="w-3 h-3 text-white"
																fill="none"
																stroke="currentColor"
																viewBox="0 0 24 24">
																<path
																	strokeLinecap="round"
																	strokeLinejoin="round"
																	strokeWidth={3}
																	d="M5 13l4 4L19 7"
																/>
															</svg>
														)}
													</button>
												)}

											<div
												className={cn(
													"flex-1 text-sm font-mono truncate",
													task.status === SubTaskStatus.CANCELLED &&
														"line-through opacity-60",
												)}
												title={task.filePath}>
												{task.filePath}
											</div>
										</div>
										{renderStatusBadge(task.status)}
									</div>

									{/* 显示执行时间 */}
									{task.startTime && task.endTime && (
										<div className="mt-1 text-xs text-vscode-descriptionForeground">
											耗时: {((task.endTime - task.startTime) / 1000).toFixed(2)}s
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				) : !isStarted && !progress ? (
					// 欢迎页面
					<div className="flex items-start justify-center h-full px-5 pt-20 pb-8">
						<div className="text-center text-vscode-descriptionForeground max-w-md">
							<div className="text-5xl mb-4">🔄</div>
							<h3 className="text-base font-semibold mb-2">Loop 循环处理</h3>
							<div className="text-left">
								<p className="text-sm mb-4 leading-relaxed text-center">
									根据声明式规则，自动识别需要处理的文件，并为每个文件创建独立任务，逐一执行。
									每个任务都关联独立对话，可随时查看详情、暂停或跳过，整个过程完全可控。
								</p>
							</div>
							<div className="text-left text-xs space-y-3 bg-vscode-sideBar-background p-3 rounded border border-vscode-editorGroup-border mb-4">
								<div>
									<strong className="text-vscode-textLink-foreground">输入格式：</strong>
									<div className="mt-2 font-mono text-vscode-descriptionForeground bg-vscode-editor-background p-2 rounded">
										#文件发现规则：[描述要处理的文件]
										<br />
										#文件处理规则：[描述处理方式]
									</div>
								</div>
								<div className="pt-2 border-t border-vscode-editorGroup-border">
									<div className="flex items-center gap-2 text-vscode-descriptionForeground">
										<span>
											支持{" "}
											<code className="px-1 py-0.5 bg-vscode-editor-background rounded">
												.gitignore
											</code>
											、
											<code className="px-1 py-0.5 bg-vscode-editor-background rounded">
												.rooignore
											</code>{" "}
											和{" "}
											<code className="px-1 py-0.5 bg-vscode-editor-background rounded">
												.coignore
											</code>{" "}
											文件过滤
										</span>
									</div>
								</div>
							</div>
						</div>
					</div>
				) : null}
			</div>

			{/* Portal容器 - 用于Popover等弹出组件 */}
			<div id="roo-portal" />

			{/* 底部输入区域 */}
			{!isStarted && (
				<div className="flex-shrink-0 border-t border-vscode-editorGroup-border">
					<ChatTextArea
						ref={textAreaRef}
						inputValue={userPrompt}
						setInputValue={setUserPrompt}
						sendingDisabled={isProcessing}
						selectApiConfigDisabled={true}
						placeholderText="请输入你的任务..."
						selectedImages={selectedImages}
						setSelectedImages={setSelectedImages}
						onSend={handleStartTask}
						onSelectImages={() => {}}
						shouldDisableImages={true}
						mode={mode}
						setMode={setMode}
						modeShortcutText=""
						hoverPreviewMap={new Map()}
					/>
				</div>
			)}
		</div>
	)
}

export default LoopView
