import { Router, type IRouter } from "express";
import chatProxyRouter from "./chatProxy";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatProxyRouter);

export default router;
