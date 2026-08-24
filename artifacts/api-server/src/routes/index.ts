import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scannerRouter from "./scanner";
import acrossRouter from "./across";
import liquidationsRouter from "./liquidations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scannerRouter);
router.use(acrossRouter);
router.use(liquidationsRouter);

export default router;
