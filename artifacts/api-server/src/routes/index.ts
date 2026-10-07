import { Router, type IRouter } from "express";
import chatProxyRouter from "./chatProxy";
import healthRouter from "./health";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(chatProxyRouter);

export default router;
